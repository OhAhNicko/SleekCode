/**
 * Native file-link hook.
 *
 * The xterm pane uses `createFilePathLinkProvider` (file-link-provider.ts) to
 * register link decorations + Ctrl+Click. The native pane has no xterm —
 * instead the Rust renderer emits `cell_hover` events on each new (line, col)
 * and `link_click` for OSC 8 hyperlinks. This hook bridges them:
 *
 *   • cell_hover  → fetch the line via nativeTermGetBufferLines, run the
 *                   URL + file-path regexes, and if the hovered col is inside
 *                   a match, set hover state so FileLinkTooltip can render a
 *                   positioned tooltip near the cell. URLs take precedence
 *                   over file paths.
 *   • cell_hover_end → clear hover state (tooltip hides).
 *   • link_click  → Ctrl+Click. A NON-empty uri is an OSC 8 hyperlink cell:
 *                   dispatch `made:open-file` for file:// URIs (stripped +
 *                   resolved) and `made:open-url` for http(s):// URIs
 *                   (forwarded to the OS shell by PaneGrid). An EMPTY uri is
 *                   PLAIN-TEXT parity — Rust can't run the regexes, so it
 *                   defers and we activate the live regex hover instead,
 *                   mirroring the xterm file-link provider's `activate`. (No
 *                   DOM click reaches JS over the native HWND, so this native
 *                   event is the only Ctrl+Click signal available.)
 *
 * Buffer reads are cached per (termId, line) for ~200ms so cell_hover firing
 * column-by-column on a fast mouse move doesn't spam the Rust IPC channel.
 */

import { useEffect, useRef, useState } from "react";
import {
  subscribeCellHover,
  subscribeCellHoverEnd,
  subscribeLinkClick,
  nativeTermGetBufferLines,
  nativeTermSetHoverLink,
  type NativeTermId,
} from "../lib/native-term-bridge";
import { findFilePathsInLine } from "../lib/file-link-provider";

interface UseNativeFileLinksOpts {
  termId: NativeTermId | null;
  workingDir: string;
}

export interface FileLinkHover {
  /** Discriminates a plain-text file path from an http(s) URL. */
  kind: "file" | "url";
  path: string; // display text (full match). For URLs, the URL itself.
  line: number; // pane-local cell row (visible space)
  col: number; // pane-local cell col (start of match)
  matchLen: number; // chars
  /**
   * Ctrl/Cmd+Click activation payload:
   *  - file: the raw (possibly relative) path, resolved against workingDir
   *    at click time.
   *  - url: the http(s) URL, opened via the OS shell.
   */
  href: string;
  /** Parsed `:line` suffix for file matches (undefined for URLs). */
  fileLine?: number;
}

export interface UseNativeFileLinksReturn {
  hover: FileLinkHover | null;
}

interface LineCacheEntry {
  text: string;
  expires: number;
}

const LINE_CACHE_TTL_MS = 200;

function resolvePath(filePath: string, workingDir: string): string {
  if (filePath.startsWith("/")) return filePath;
  const base = workingDir.endsWith("/") ? workingDir : workingDir + "/";
  return base + filePath;
}

// Plain-text http(s) URL matcher — mirrors findFilePathsInLine's approach so
// bare URLs in terminal output become hoverable + Ctrl+Click clickable even
// when the shell didn't wrap them in an OSC 8 hyperlink. The character class
// stops at whitespace and closing brackets/quotes; trailing sentence
// punctuation is trimmed so "see https://x.com/y." doesn't grab the period.
const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/gi;

interface UrlMatch {
  url: string;
  startIndex: number;
  endIndex: number;
}

function findUrlsInLine(lineText: string): UrlMatch[] {
  const matches: UrlMatch[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(lineText)) !== null) {
    const raw = m[0];
    const trimmed = raw.replace(/[.,;:!?]+$/, "");
    if (!trimmed) continue;
    matches.push({
      url: trimmed,
      startIndex: m.index,
      endIndex: m.index + trimmed.length,
    });
  }
  return matches;
}

export function useNativeFileLinks({
  termId,
  workingDir,
}: UseNativeFileLinksOpts): UseNativeFileLinksReturn {
  // Keep workingDir current without re-subscribing on every change.
  const workingDirRef = useRef(workingDir);
  useEffect(() => {
    workingDirRef.current = workingDir;
  }, [workingDir]);

  const [hover, setHover] = useState<FileLinkHover | null>(null);

  // Mirror the live hover into a ref so the window click listener (registered
  // once, below) reads the cell currently under the cursor without re-binding.
  const hoverRef = useRef<FileLinkHover | null>(null);
  useEffect(() => {
    hoverRef.current = hover;
  }, [hover]);

  // Mirror "a link is hovered" to Rust so WM_SETCURSOR can show the hand
  // cursor while Ctrl is held (the Ctrl+Click affordance). Boolean-keyed so
  // intra-link movement doesn't spam the command.
  const hoverActive = hover != null;
  useEffect(() => {
    if (termId == null) return;
    nativeTermSetHoverLink(termId, hoverActive).catch(() => {});
    return () => {
      if (hoverActive) nativeTermSetHoverLink(termId, false).catch(() => {});
    };
  }, [termId, hoverActive]);

  // S13/S12 plain-text parity is driven by the Rust `link_click` event with an
  // EMPTY uri (emitted on Ctrl/Cmd+Click of a non-hyperlink cell), handled in
  // the termId-scoped subscription below. A window "click" listener can't work
  // here: clicks on the native terminal HWND are consumed by Rust and never
  // surface as a DOM click, so the native event is the only signal available.
  useEffect(() => {
    if (termId == null) {
      setHover(null);
      return;
    }
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    const lineCache = new Map<number, LineCacheEntry>();
    let lastHoverSeq = 0;

    // Clear-hysteresis: at a link's cell boundary, hover match / no-match
    // alternate every couple of pixels. Clearing instantly made the tooltip
    // strobe AND randomly broke Ctrl+Click (the empty-uri link_click consumer
    // reads hoverRef, which was null half the time). A short grace before
    // clearing keeps both stable; any fresh match cancels the pending clear.
    let clearTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelClear = () => {
      if (clearTimer) {
        clearTimeout(clearTimer);
        clearTimer = null;
      }
    };
    const scheduleClear = () => {
      if (clearTimer) return;
      clearTimer = setTimeout(() => {
        clearTimer = null;
        if (!cancelled) setHover(null);
      }, 150);
    };

    async function fetchLine(line: number): Promise<string | null> {
      const now = Date.now();
      const cached = lineCache.get(line);
      if (cached && cached.expires > now) return cached.text;
      try {
        const lines = await nativeTermGetBufferLines(
          termId as NativeTermId,
          line,
          line + 1,
        );
        const text = lines[0] ?? "";
        lineCache.set(line, { text, expires: now + LINE_CACHE_TTL_MS });
        // Trivial cache cap: drop oldest entries past 64.
        if (lineCache.size > 64) {
          const firstKey = lineCache.keys().next().value;
          if (firstKey !== undefined) lineCache.delete(firstKey);
        }
        return text;
      } catch {
        return null;
      }
    }

    (async () => {
      const uHover = await subscribeCellHover(termId, (e) => {
        if (cancelled) return;
        const seq = ++lastHoverSeq;
        (async () => {
          const text = await fetchLine(e.line);
          if (cancelled || seq !== lastHoverSeq) return;
          if (!text) {
            scheduleClear();
            return;
          }
          // URLs take precedence over file paths — a URL whose tail looks
          // like a file (…/app.ts) should open in the browser, not the editor.
          const urlHit = findUrlsInLine(text).find(
            (m) => e.col >= m.startIndex && e.col < m.endIndex,
          );
          if (urlHit) {
            cancelClear();
            setHover((prev) => {
              if (
                prev &&
                prev.kind === "url" &&
                prev.href === urlHit.url &&
                prev.line === e.line &&
                prev.col === urlHit.startIndex
              ) {
                return prev;
              }
              return {
                kind: "url",
                path: urlHit.url,
                line: e.line,
                col: urlHit.startIndex,
                matchLen: urlHit.endIndex - urlHit.startIndex,
                href: urlHit.url,
              };
            });
            return;
          }

          const hit = findFilePathsInLine(text).find(
            (m) => e.col >= m.startIndex && e.col < m.endIndex,
          );
          if (!hit) {
            scheduleClear();
            return;
          }
          cancelClear();
          setHover((prev) => {
            // Avoid setState churn when the same hit is re-reported on each
            // intra-match column step. Only update when path/line/col change.
            if (
              prev &&
              prev.kind === "file" &&
              prev.path === hit.text &&
              prev.line === e.line &&
              prev.col === hit.startIndex
            ) {
              return prev;
            }
            return {
              kind: "file",
              path: hit.text,
              line: e.line,
              col: hit.startIndex,
              matchLen: hit.endIndex - hit.startIndex,
              href: hit.filePath,
              fileLine: hit.line,
            };
          });
        })();
      });
      unlistens.push(uHover);

      const uEnd = await subscribeCellHoverEnd(termId, () => {
        if (cancelled) return;
        lastHoverSeq++;
        scheduleClear();
      });
      unlistens.push(uEnd);

      const uClick = await subscribeLinkClick(termId, (e) => {
        if (cancelled) return;
        const uri = e.uri;
        if (!uri) {
          // S12/S13 plain-text parity: an empty uri means Ctrl/Cmd+Click landed
          // on a NON-hyperlink cell. Rust can't run the URL/file-path regexes,
          // so it defers to us: activate the regex link currently under the
          // cursor (live hover), mirroring xterm's Ctrl+Click on plain text.
          // Clicks on the native terminal HWND never produce a DOM `click`
          // (Rust owns the mouse), so this native event — not a window click
          // listener — is the only path that fires here.
          const h = hoverRef.current;
          if (!h) return;
          if (h.kind === "url") {
            window.dispatchEvent(
              new CustomEvent("made:open-url", { detail: { url: h.href } }),
            );
          } else {
            const resolved = resolvePath(h.href, workingDirRef.current);
            window.dispatchEvent(
              new CustomEvent("made:open-file", {
                detail: { filePath: resolved, lineNumber: h.fileLine },
              }),
            );
          }
          return;
        }

        // OSC 8 hyperlink — could be file://, http(s)://, or anything else.
        if (/^https?:\/\//i.test(uri)) {
          if (import.meta.env.DEV) {
            console.debug("[useNativeFileLinks] link_click http", uri);
          }
          window.dispatchEvent(
            new CustomEvent("made:open-url", { detail: { url: uri } }),
          );
          return;
        }

        let filePath = uri;
        if (filePath.startsWith("file://")) {
          filePath = filePath.replace(/^file:\/\/(?:localhost)?/, "");
        }
        const resolved = resolvePath(filePath, workingDirRef.current);
        window.dispatchEvent(
          new CustomEvent("made:open-file", {
            detail: { filePath: resolved, lineNumber: e.line },
          }),
        );
      });
      unlistens.push(uClick);
    })();

    return () => {
      cancelled = true;
      cancelClear();
      for (const u of unlistens) u();
      lineCache.clear();
      setHover(null);
    };
  }, [termId]);

  return { hover };
}

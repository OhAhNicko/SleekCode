/**
 * Native file-link hook.
 *
 * The xterm pane uses `createFilePathLinkProvider` (file-link-provider.ts) to
 * register link decorations + Ctrl+Click. The native pane has no xterm —
 * instead the Rust renderer emits `cell_hover` events on each new (line, col)
 * and `link_click` for OSC 8 hyperlinks. This hook bridges them:
 *
 *   • cell_hover  → fetch the line via nativeTermGetBufferLines, run the
 *                   file-path regex, and if the hovered col is inside a
 *                   match, set hover state so FileLinkTooltip can render a
 *                   positioned tooltip near the cell.
 *   • cell_hover_end → clear hover state (tooltip hides).
 *   • link_click  → dispatch the existing `made:open-file` event with the
 *                   resolved URI. File:// URIs are stripped; http(s)://
 *                   are forwarded to the OS shell.
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
  type NativeTermId,
} from "../lib/native-term-bridge";
import { findFilePathsInLine } from "../lib/file-link-provider";

interface UseNativeFileLinksOpts {
  termId: NativeTermId | null;
  workingDir: string;
}

export interface FileLinkHover {
  path: string;
  line: number; // pane-local cell row (visible space)
  col: number; // pane-local cell col (start of match)
  matchLen: number; // chars
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

  useEffect(() => {
    if (termId == null) {
      setHover(null);
      return;
    }
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    const lineCache = new Map<number, LineCacheEntry>();
    let lastHoverSeq = 0;

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
            setHover(null);
            return;
          }
          const matches = findFilePathsInLine(text);
          if (matches.length === 0) {
            setHover(null);
            return;
          }
          const hit = matches.find(
            (m) => e.col >= m.startIndex && e.col < m.endIndex,
          );
          if (!hit) {
            setHover(null);
            return;
          }
          setHover((prev) => {
            // Avoid setState churn when the same hit is re-reported on each
            // intra-match column step. Only update when path/line/col change.
            if (
              prev &&
              prev.path === hit.text &&
              prev.line === e.line &&
              prev.col === hit.startIndex
            ) {
              return prev;
            }
            return {
              path: hit.text,
              line: e.line,
              col: hit.startIndex,
              matchLen: hit.endIndex - hit.startIndex,
            };
          });
        })();
      });
      unlistens.push(uHover);

      const uEnd = await subscribeCellHoverEnd(termId, () => {
        if (cancelled) return;
        lastHoverSeq++;
        setHover(null);
      });
      unlistens.push(uEnd);

      const uClick = await subscribeLinkClick(termId, (e) => {
        if (cancelled) return;
        const uri = e.uri;
        if (!uri) return;

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
      for (const u of unlistens) u();
      lineCache.clear();
      setHover(null);
    };
  }, [termId]);

  return { hover };
}

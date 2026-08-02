/**
 * "Is this buffer line a user prompt?" — the fallback prompt index used when a
 * pane has no OSC 133 shell integration.
 *
 * Both renderers need this and both used to carry their own copy. That is how
 * the native pane ended up with prompt navigation that could never fire: its
 * copy read OSC 133;A `promptLines`, which is permanently empty there (nothing
 * injects shell integration into a native pane, and Claude/Codex/Gemini emit no
 * OSC 133 of their own), while the xterm copy had a working regex fallback. One
 * implementation, one behaviour.
 *
 * Deliberately strict. An earlier version tested `/[$#❯]\s/` anywhere in the
 * line, which matched Python and shell comments (`# Populate the cache`) and
 * scattered the jump targets through ordinary output.
 */
import type { TerminalType } from "../types";

/** CLIs that render user messages with a chevron rather than a shell sigil. */
function isAiCli(type: TerminalType | undefined): boolean {
  return type === "claude" || type === "codex" || type === "gemini";
}

/**
 * `raw` is one line exactly as the terminal holds it — leading spaces intact,
 * since the column of the sigil is half the test.
 */
export function isPromptLine(raw: string, terminalType: TerminalType | undefined): boolean {
  const isAI = isAiCli(terminalType);
  const sigilRegex = isAI ? /[>❯›»]/ : /[$#❯]/;
  const col = raw.search(sigilRegex);
  // Sigil at column 0 or 1 — one leading space allows for a TUI box edge.
  if (col < 0 || col > 1) return false;
  const trimmed = raw.trim();
  const startRegex = isAI ? /^[>❯›»]\s/ : /^[$#❯]\s/;
  if (!startRegex.test(trimmed)) return false;
  if (isAI) {
    // Skip numbered selection items (`> 3. Option`) and empty markers.
    const after = trimmed.replace(/^[>❯›»]\s?/, "").trim();
    if (/^\d+[.)]/.test(after)) return false;
    if (after.length < 2) return false;
  }
  return true;
}

/** The prompt's text with its sigil removed, for a history label. */
export function promptLineText(raw: string): string {
  return raw.trim().replace(/^[>❯›»$#]\s?/, "").trim();
}

/**
 * Indices (into `lines`) of every prompt line, ascending.
 *
 * Callers hold `lines` in their own coordinate space — the native pane reads
 * `[baseY, rows)` so index i is an OSC-133-style absLine, and converts back
 * through the live `baseY` when it scrolls.
 */
export function findPromptLines(
  lines: string[],
  terminalType: TerminalType | undefined,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isPromptLine(lines[i] ?? "", terminalType)) out.push(i);
  }
  return out;
}

/**
 * Cap a CLI-supplied session title before it becomes a MADE session name.
 *
 * Claude's titles arrive pre-shortened — `resolveSessionName` runs a first
 * prompt through `slugify`, which keeps 4 words. Codex and Gemini have no such
 * step: Codex hands back `threads.title` verbatim, which is the RAW first
 * message until the CLI gets around to summarising it, and Gemini's `summary`
 * is whatever the model wrote. A pane that opened on a long prompt therefore
 * took a ~250-character name, which then ate the entire terminal header and was
 * written into the project-session registry that way.
 *
 * Capping at the source (rather than only clamping the CSS) keeps the header,
 * the session picker, the rename input's seed value and the persisted registry
 * showing the same string. Full text stays reachable — every surface that
 * renders a session name also carries it as a tooltip.
 */

/** Longest session name we keep. Roughly one header's worth at 9px. */
export const SESSION_TITLE_MAX = 60;

/**
 * First line, collapsed whitespace, capped at `SESSION_TITLE_MAX` with a real
 * ellipsis character. Returns "" for empty/whitespace input so callers can keep
 * using falsiness to mean "no name yet".
 *
 * Breaks at a word boundary when one is close to the limit, so the cap does not
 * land mid-word; falls back to a hard cut for a single long token (a URL, a
 * path) where there is no boundary to find.
 */
export function truncateSessionTitle(raw: string, max = SESSION_TITLE_MAX): string {
  const oneLine = raw.split("\n")[0].replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const cut = oneLine.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Only honour a boundary in the last third — an early space would throw away
  // most of the budget (e.g. "A very long…" for a name that starts "A").
  const body = lastSpace > max * 0.66 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

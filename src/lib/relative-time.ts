/**
 * Compact relative time — "5m ago", "2h ago", "3d ago", "4mo ago".
 *
 * One implementation for the three places that had grown their own identical
 * copy (pane header, command history, and now the Jira rail's meta line).
 *
 * NOT the only relative-time voice in the app: lib/screenshots.ts owns a
 * VERBOSE one ("5 min ago", "3 h ago", then an absolute date) used by the
 * screenshot and knowledge surfaces. That is a deliberate second register for
 * places with room to breathe, not a duplicate to fold in — merging them would
 * change visible strings in four unrelated components for no benefit here.
 */

/** Epoch-ms in, compact relative string out. Future timestamps render as
 *  "just now" rather than a negative age — clock skew between a server and
 *  this machine is common and must not print nonsense. */
export function relativeShort(timestamp: number, now = Date.now()): string {
  const diff = now - timestamp;
  if (!Number.isFinite(diff) || diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** ISO-8601 in (Jira's `created` / `updated`), compact relative string out.
 *  An empty or unparseable date yields "" so a caller can drop the field
 *  rather than print "NaN ago". */
export function relativeShortIso(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  return relativeShort(ms, now);
}

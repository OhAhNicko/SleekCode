// Release notes for the post-update changelog popup.
//
// Why this is fetched at launch rather than handed over by the installer:
// the update flow used to stash the notes in the zustand store (localStorage)
// and then immediately call relaunch(). WebView2 commits localStorage to its
// LevelDB on a delay, so killing the process right after the write loses it —
// `pendingChangelog` never once reached disk, and the popup never appeared.
// Fetching on the next launch removes the cross-process handoff entirely.
//
// It also fixes the content: the Tauri updater's `Update.body` comes from
// latest.json's `notes`, which CI hardcodes to the placeholder "See the assets
// below to download and install." The real changelog is the GitHub *release
// body*, which the updater never reads.

// Repo hosting the GitHub releases the updater pulls from (mirrors the
// updater endpoint in tauri.conf.json).
export const RELEASES_REPO = "OhAhNicko/SleekCode";

// The ChangelogModal renders notes as pre-wrap PLAIN TEXT, so strip the
// markdown the GitHub release body is written in (headings, emphasis, code,
// links) — otherwise the modal shows literal `##`/`**` characters.
export function markdownToPlainText(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .replace(/^\s*#{1,6}\s+/gm, "") // headings -> text
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold -> text
    .replace(/`([^`]+)`/g, "$1") // inline code -> text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1: $2") // links -> "text: url"
    .replace(/\n{3,}/g, "\n\n") // collapse blank runs
    .trim();
}

/**
 * Plain-text release body for `version`, or null if it can't be had (offline,
 * rate-limited, tag missing). Callers treat null as "no popup this launch".
 * Public repo, and the CSP allows https: connect-src.
 */
export async function fetchReleaseNotes(version: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${RELEASES_REPO}/releases/tags/v${version}`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { body?: unknown };
    if (typeof data.body !== "string") return null;
    const plain = markdownToPlainText(data.body);
    return plain.length > 0 ? plain : null;
  } catch {
    return null;
  }
}

/** Client-side branch-name pre-check, shared by the main webview (create
 * handler) and the overlay's git-branch menu (inline form). Server-side
 * `git check-ref-format` remains the source of truth; this only avoids the
 * round-trip for obvious cases. */
export function validateBranchName(n: string): string | null {
  const t = n.trim();
  if (!t) return null; // empty: disable submit without showing error
  if (/\s/.test(t)) return "No spaces allowed";
  if (/[~^:?*[\\]/.test(t)) return "Invalid characters";
  if (t.startsWith("-") || t.startsWith("/") || t.endsWith("/")) return "Invalid placement";
  if (t.includes("..") || t.includes("//")) return "Invalid sequence";
  return null;
}

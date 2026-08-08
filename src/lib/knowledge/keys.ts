import { isWindows } from "../platform";

/**
 * The ONE way the frontend folds a project path into a knowledge key.
 *
 * The event payload's `projectKey` is produced by the Rust side's folding
 * (`file_watch::norm`, shared with the service registry). If the two ever
 * disagree by a byte, `applyEvent` finds no entry and the sidebar silently
 * stops refreshing — a failure with no error message anywhere. So there is
 * exactly one helper, it is used by every project-keyed map in this feature,
 * and the event carries the raw `projectPath` as well so a mismatch degrades
 * to a slower match instead of a dead UI.
 *
 * The repo already carries three drifted path-slug encoders (documented bug
 * class — see the Claude project-slug learnings). Do not add a fourth: if a
 * new call site needs folding, import this.
 *
 * Folding rules, in order:
 *   1. backslashes → forward slashes  (`C:\a` and `C:/a` are one project)
 *   2. trailing slashes trimmed       (`C:/a/` and `C:/a` are one project)
 *   3. lowercased on Windows only     (NTFS is case-insensitive; ext4 is not)
 */
export function canonicalProjectKey(path: string): string {
  if (!path) return "";
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return isWindows() ? slashed.toLowerCase() : slashed;
}

/**
 * True when two paths name the same project under the folding above. Use this
 * rather than comparing raw strings — a tab's `workingDir` and the service's
 * `projectPath` routinely differ in separators and drive-letter case.
 */
export function sameProjectPath(a: string, b: string): boolean {
  return !!a && !!b && canonicalProjectKey(a) === canonicalProjectKey(b);
}

/** Last path segment, separator-agnostic — the name shown as "<project>". */
export function projectLeafName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * The projection directory every knowledge file lives under — a per-BUILD
 * value, not a constant: debug builds live in `.project-memory-dev` so dev
 * and live MADE can never share content. This is the release spelling as a
 * safe default; `KnowledgeEngine` fetches the authoritative name from the
 * `knowledge_world` command at boot and applies it here. A `let` export is a
 * live binding, so every importer sees the applied value — including the
 * path-matching helpers below, which read it at call time.
 */
export let MEMORY_DIR_NAME = ".project-memory";

/** Boot-time application of the Rust-served world names. Tolerant of a
 *  missing field — the release defaults simply stand. */
export function applyKnowledgeWorld(world: { memoryDirName?: unknown }): void {
  if (typeof world.memoryDirName === "string" && world.memoryDirName) {
    MEMORY_DIR_NAME = world.memoryDirName;
  }
}

/**
 * True when `filePath` is inside a `.project-memory` directory.
 *
 * Both separators are checked because the path can arrive from either side of
 * the WSL boundary. Used by the file viewer to declare its own saves to the
 * service, so a MADE-authored edit is attributed to the user rather than
 * arriving as an anonymous external change.
 */
export function isMemoryFilePath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/");
  return p.includes(`/${MEMORY_DIR_NAME}/`);
}

/**
 * The project a `.project-memory` file belongs to, or null if it is not one.
 *
 * Derived from the path rather than looked up in the tab list on purpose: the
 * file viewer is a global surface and the file it is saving may well belong to
 * a project that is not the active tab.
 */
export function projectRootForMemoryFile(filePath: string): string | null {
  const p = filePath.replace(/\\/g, "/");
  const idx = p.indexOf(`/${MEMORY_DIR_NAME}/`);
  return idx === -1 ? null : p.slice(0, idx);
}

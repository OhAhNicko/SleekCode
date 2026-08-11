/**
 * Jira CLI folder "groups" — the folders ticket CLI panes spawn in.
 *
 * A group is a real folder plus an optional user-given name ("Group name").
 * The list is GLOBAL (Settings → Jira → CLI folders), shared by every Jira
 * project; keyed (folderless) projects pick one per ticket in the new-ticket
 * dialog, and remember the last pick per project. Legacy folder-based Jira
 * projects ignore groups entirely — their panes keep spawning in the project
 * folder.
 *
 * Pure helpers only (no store import): TerminalHeader and the modals both
 * consume these against the store's `jiraCliGroups`.
 */

export interface JiraCliGroup {
  id: string;
  /** Real folder path, as picked (Windows or WSL form). */
  path: string;
  /** Optional in-app "Group name". Absent → the folder's basename stands in. */
  name?: string;
}

/** Slash-normalized, trailing-slash-free — the identity used for dedupe and
 *  path → group lookup (same normalization the session registry uses). */
export const normalizeGroupPath = (p: string): string =>
  p.replace(/\\/g, "/").replace(/\/+$/, "");

/** Last path segment — the display fallback for an unnamed group. */
export function folderBasename(p: string): string {
  const parts = normalizeGroupPath(p).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function groupForPath(
  groups: JiraCliGroup[],
  path: string,
): JiraCliGroup | undefined {
  const key = normalizeGroupPath(path);
  return groups.find((g) => normalizeGroupPath(g.path) === key);
}

/** What a pane header / picker row calls this folder: the group's name when
 *  one is set, else the folder's basename. */
export function jiraGroupLabel(groups: JiraCliGroup[], path: string): string {
  const g = groupForPath(groups, path);
  return g?.name?.trim() || folderBasename(path);
}

/** The group a JSM request type is linked to (Settings → Jira → Request
 *  types), or undefined for unlinked/unknown types and dangling ids. */
export function groupForRequestType(
  groups: JiraCliGroup[],
  mapping: Record<string, string>,
  requestType: string | undefined,
): JiraCliGroup | undefined {
  if (!requestType) return undefined;
  const gid = mapping[requestType];
  return gid ? groups.find((g) => g.id === gid) : undefined;
}

/** What a ticket ROW shows in its request-type slot: the linked GROUP's name
 *  when the type is linked, else the request type itself. */
export function requestTypeDisplay(
  groups: JiraCliGroup[],
  mapping: Record<string, string>,
  requestType: string | undefined,
): string | undefined {
  const g = groupForRequestType(groups, mapping, requestType);
  if (!g) return requestType;
  return g.name?.trim() || folderBasename(g.path);
}

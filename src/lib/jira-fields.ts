/**
 * What a Jira site can show on a ticket, and which of it the user wants.
 *
 * Jira Service Management models Organizations and Request type as CUSTOM
 * fields, so their ids (`customfield_10002`, …) differ per site and cannot be
 * hardcoded. One `jira_site_meta` call per site gives the whole catalogue,
 * which then serves three jobs: locating those two by KIND (the schema's
 * custom type — a field's real identity), populating the Settings pickers so
 * any other field can be added as a column, and caching the site's real
 * priority order so the client sort stops guessing from names.
 *
 * All of it is persisted, so the request happens once ever per site rather
 * than once per session.
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { JiraFieldMeta } from "../store/recentProjectsSlice";

/** Schema custom-types of the two fields worth auto-detecting. Matched by
 *  SUFFIX because Atlassian prefixes them with the app key. */
const ORG_KIND = "sd-customer-organizations";
const REQUEST_TYPE_KINDS = ["vp-origin", "sd-request-type", "sd-customer-request-type"];

/** Fields that would never read as a one-line column, or that are already
 *  shown elsewhere on the row. Hidden from the pickers to keep them usable —
 *  a raw list is ~150 entries on a mature site. */
const PICKER_HIDDEN_KINDS = new Set([
  "description",
  "comment",
  "attachment",
  "worklog",
  "issuelinks",
  "timetracking",
  "watches",
  "votes",
  "sub-tasks",
  "subtasks",
]);
const PICKER_HIDDEN_IDS = new Set([
  "summary",
  "status",
  "assignee",
  "reporter",
  "priority",
  "created",
  "updated",
  "issuekey",
  "thumbnail",
]);

export interface JiraFieldSpec {
  org?: string;
  requestType?: string;
  extra: string[];
}

export function orgFieldId(fields: JiraFieldMeta[] | undefined): string | undefined {
  return fields?.find((f) => f.kind?.endsWith(ORG_KIND))?.id
    ?? fields?.find((f) => f.name.toLowerCase() === "organizations")?.id;
}

export function requestTypeFieldId(fields: JiraFieldMeta[] | undefined): string | undefined {
  return (
    fields?.find((f) => REQUEST_TYPE_KINDS.some((k) => f.kind?.endsWith(k)))?.id
    ?? fields?.find((f) => f.name.toLowerCase() === "request type")?.id
  );
}

/** Catalogue for a site, fetching it the first time. An empty ARRAY is a valid
 *  cached answer ("looked, nothing usable") and is what stops a site without
 *  the permission re-listing every field on every poll. */
export async function ensureSiteFields(siteId: string): Promise<JiraFieldMeta[]> {
  const s = useAppStore.getState();
  const cached = (s.jiraSiteFields ?? {})[siteId];
  if (cached) return cached;
  try {
    const meta = await invoke<{ fields: JiraFieldMeta[]; priorities: string[] }>(
      "jira_site_meta",
      { baseUrl: siteId, email: s.jiraApiEmail, token: s.jiraApiToken },
    );
    const fresh = useAppStore.getState();
    fresh.setJiraSiteFields(siteId, meta.fields ?? []);
    fresh.setJiraSitePriorities(siteId, meta.priorities ?? []);
    return meta.fields ?? [];
  } catch {
    // Do NOT cache a failure — a transient network error must not disable
    // every extra column for the rest of the session.
    return [];
  }
}

/** What to ask Jira for on this site: the two auto-detected JSM fields plus
 *  whatever the user ticked, filtered to ids this site actually has. */
export async function fieldSpecFor(siteId: string): Promise<JiraFieldSpec> {
  const fields = await ensureSiteFields(siteId);
  const s = useAppStore.getState();
  const picked = s.jiraExtraFields ?? { rows: [], header: [] };
  const known = new Set(fields.map((f) => f.id));
  const extra = [...new Set([...(picked.rows ?? []), ...(picked.header ?? [])])].filter((id) =>
    known.has(id),
  );
  return { org: orgFieldId(fields), requestType: requestTypeFieldId(fields), extra };
}

/** The catalogue as the Settings pickers show it: usable one-line fields only,
 *  minus the ones the row already has a dedicated column for, name-sorted. */
export function pickableFields(fields: JiraFieldMeta[] | undefined): JiraFieldMeta[] {
  const org = orgFieldId(fields);
  const req = requestTypeFieldId(fields);
  return (fields ?? [])
    .filter((f) => {
      if (f.id === org || f.id === req) return false; // first-class already
      if (PICKER_HIDDEN_IDS.has(f.id)) return false;
      const kind = f.kind ?? "";
      const tail = kind.includes(":") ? kind.slice(kind.lastIndexOf(":") + 1) : kind;
      return !PICKER_HIDDEN_KINDS.has(tail);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Display label for a field id, falling back to the id so a column whose
 *  field was removed from the site still says which one it was. */
export function fieldLabel(fields: JiraFieldMeta[] | undefined, id: string): string {
  return fields?.find((f) => f.id === id)?.name ?? id;
}

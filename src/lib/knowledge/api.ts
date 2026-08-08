import { invoke } from "@tauri-apps/api/core";
import type {
  ContextPackage,
  KnowledgeConflict,
  KnowledgeConflictDetail,
  KnowledgeConflictResolution,
  KnowledgeConflictResolveResult,
  KnowledgeHandoff,
  KnowledgeNoteDetail,
  KnowledgeNoteMeta,
  KnowledgePolicy,
  KnowledgeProjectStatus,
  KnowledgeRevisionInfo,
  KnowledgeRevisionSnapshot,
  KnowledgeSearchResult,
  KnowledgeStatus,
} from "./types";

/**
 * Typed wrappers over the `knowledge_*` Tauri commands.
 *
 * Every knowledge invoke in the app goes through this file. Two reasons:
 *
 *  - **One timeout policy.** The service is in-process, but reaching it still
 *    crosses an IPC hop, and the UI behind these calls has one unrecoverable
 *    failure mode: a panel that spins forever. So each call carries its own
 *    bound (the `jira-mcp.ts` pattern), long enough that a real backend error
 *    wins the race and gets shown.
 *
 *  - **One degradation story.** A missing command, a service that failed to
 *    start, a project that was never opened — all of it lands on the same
 *    honest state: status `unavailable` with the error text and a Retry
 *    button. Nothing here throws its way up into a render.
 *
 * The service canonicalizes paths itself, so callers pass the raw
 * `tab.workingDir`. The UI actor is always `user` server-side — the frontend
 * cannot claim to be an agent.
 */

/** Reads. Slower than this means the service is not answering at all. */
const READ_TIMEOUT_MS = 15_000;
/**
 * Writes. Longer because a commit does real work — snapshot, projection write,
 * graph update — and a scaffold walks the project directory once.
 */
const WRITE_TIMEOUT_MS = 30_000;

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function read<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return withTimeout(invoke<T>(command, args), READ_TIMEOUT_MS, `${command} timed out`);
}

function write<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return withTimeout(invoke<T>(command, args), WRITE_TIMEOUT_MS, `${command} timed out`);
}

/** Error text a caller can show. Tauri rejects with a string, not an Error. */
export function knowledgeErrorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Result of an attach or status read. `ok:false` is a first-class outcome —
 * the service may legitimately not exist yet in a given build — and the caller
 * turns it into the `unavailable` panel rather than an exception.
 */
export type StatusResult =
  | { ok: true; status: KnowledgeProjectStatus }
  | { ok: false; error: string };

/**
 * Shape-tolerant status parsing.
 *
 * The service answers `knowledge_open(init:false)` for a project with no
 * `.project-memory` with an uninitialized marker rather than a full status
 * record, and it may name that field `state` or `status`. Normalizing here
 * means every consumer sees one `KnowledgeProjectStatus`, and a field the
 * backend has not shipped yet reads as its safe default instead of `undefined`
 * leaking into a render.
 */
function toProjectStatus(raw: unknown): KnowledgeProjectStatus {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawState = typeof r.status === "string" ? r.status : typeof r.state === "string" ? r.state : "";
  const known: KnowledgeStatus[] = [
    "loading",
    "uninitialized",
    "ready",
    "readonly",
    "unavailable",
    "remote-unsupported",
  ];
  const status: KnowledgeStatus = (known as string[]).includes(rawState)
    ? (rawState as KnowledgeStatus)
    : "ready";
  const policy = r.policy === "read-only" || r.policy === "trusted" ? r.policy : "ask";
  return {
    status,
    readonlyReason: typeof r.readonlyReason === "string" ? r.readonlyReason : undefined,
    revision: typeof r.revision === "number" ? r.revision : 0,
    noteCount: typeof r.noteCount === "number" ? r.noteCount : 0,
    conflictCount: typeof r.conflictCount === "number" ? r.conflictCount : 0,
    pendingApprovals: typeof r.pendingApprovals === "number" ? r.pendingApprovals : 0,
    policy: policy as KnowledgePolicy,
    presence: Array.isArray(r.presence) ? (r.presence as KnowledgeProjectStatus["presence"]) : [],
    memoryDir: typeof r.memoryDir === "string" ? r.memoryDir : undefined,
    gitignored: typeof r.gitignored === "boolean" ? r.gitignored : undefined,
  };
}

/**
 * Attach a project's knowledge service.
 *
 * `init:false` NEVER writes — MADE has never created files in a project
 * unasked, and this is not the feature that starts. An uninitialized project
 * comes back as `uninitialized` and the sidebar offers the explicit
 * "Initialize NexusMind" affordance; `init:true` is only ever sent from that
 * button.
 */
export async function openProject(projectPath: string, init: boolean): Promise<StatusResult> {
  try {
    const raw = await write<unknown>("knowledge_open", { projectPath, init });
    return { ok: true, status: toProjectStatus(raw) };
  } catch (e) {
    return { ok: false, error: knowledgeErrorText(e) };
  }
}

export async function readProjectStatus(projectPath: string): Promise<StatusResult> {
  try {
    const raw = await read<unknown>("knowledge_status", { projectPath });
    return { ok: true, status: toProjectStatus(raw) };
  } catch (e) {
    return { ok: false, error: knowledgeErrorText(e) };
  }
}

/**
 * Does this project have knowledge at all — WITHOUT attaching it.
 *
 * `knowledge_status` is a pure probe: for an unattached project it stats
 * `.project-memory/` and answers `uninitialized` when it is absent, opening no
 * database and no watcher. This is the Jira-tab gate: NexusMind is not offered
 * there, but a repo that was initialized elsewhere must keep working, so the
 * decision needs an answer that costs nothing when it is "no".
 *
 * A failed probe answers `false` — for a surface that OFFERS the feature that
 * is the quiet option, and the next activation simply probes again.
 */
export async function probeInitialized(projectPath: string): Promise<boolean> {
  const r = await readProjectStatus(projectPath);
  return r.ok && r.status.status !== "uninitialized";
}

/** Re-run the reconcile walk. The designed fallback where filesystem watches
 *  do not fire (`\\wsl.localhost` over 9P), and what sidebar Refresh calls. */
export function rescanProject(projectPath: string): Promise<void> {
  return write<void>("knowledge_rescan", { projectPath });
}

export function listNotes(projectPath: string): Promise<KnowledgeNoteMeta[]> {
  return read<KnowledgeNoteMeta[]>("knowledge_list_notes", { projectPath });
}

/**
 * Shape-tolerant detail parsing, same contract as `toProjectStatus`: arrays
 * the panel reads `.length` on default to empty instead of leaking undefined
 * into a render, and the adapter-wire `{meta, content}` nesting — the drift
 * that crashed the panel on its first real run — flattens instead of failing.
 */
function toNoteDetail(raw: unknown): KnowledgeNoteDetail {
  const r = (raw ?? {}) as Record<string, unknown>;
  const base =
    typeof r.meta === "object" && r.meta !== null
      ? ({ ...(r.meta as Record<string, unknown>), content: r.content } as Record<string, unknown>)
      : r;
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    ...(base as unknown as KnowledgeNoteDetail),
    tags: arr(base.tags),
    backlinks: arr(base.backlinks),
    outgoingLinks: arr(base.outgoingLinks),
  };
}

export function getNote(projectPath: string, entityId: string): Promise<KnowledgeNoteDetail> {
  return read<unknown>("knowledge_get_note", { projectPath, entityId }).then(toNoteDetail);
}

export function searchKnowledge(
  projectPath: string,
  query: string,
  limit = 50,
): Promise<KnowledgeSearchResult[]> {
  return read<KnowledgeSearchResult[]>("knowledge_search", { projectPath, query, limit });
}

export function createNote(projectPath: string, title: string): Promise<KnowledgeNoteMeta> {
  return write<KnowledgeNoteMeta>("knowledge_create_note", { projectPath, title });
}

export function renameNote(
  projectPath: string,
  entityId: string,
  title: string,
  baseRevision: number,
): Promise<KnowledgeNoteMeta> {
  return write<KnowledgeNoteMeta>("knowledge_rename_note", {
    projectPath,
    entityId,
    title,
    baseRevision,
  });
}

/** Archive, never delete. Spec §7.8: nothing in this feature destroys history. */
export function archiveNote(
  projectPath: string,
  entityId: string,
  baseRevision: number,
): Promise<void> {
  return write<void>("knowledge_archive_note", { projectPath, entityId, baseRevision });
}

export function restoreNote(projectPath: string, entityId: string): Promise<void> {
  return write<void>("knowledge_restore_note", { projectPath, entityId });
}

export function listRevisions(
  projectPath: string,
  entityId: string,
): Promise<KnowledgeRevisionInfo[]> {
  return read<KnowledgeRevisionInfo[]>("knowledge_history", { projectPath, entityId });
}

export function getRevision(
  projectPath: string,
  entityId: string,
  revision: number,
): Promise<KnowledgeRevisionSnapshot> {
  return read<KnowledgeRevisionSnapshot>("knowledge_get_revision", {
    projectPath,
    entityId,
    revision,
  });
}

/** Restore-as-NEW-revision. The current head is never discarded. */
export function restoreRevision(
  projectPath: string,
  entityId: string,
  revision: number,
): Promise<void> {
  return write<void>("knowledge_restore_revision", { projectPath, entityId, revision });
}

export function listConflicts(projectPath: string): Promise<KnowledgeConflict[]> {
  return read<KnowledgeConflict[]>("knowledge_list_conflicts", { projectPath });
}

/**
 * Full text of both sides of a conflict.
 *
 * The service MAY inline `yours`/`current` on the list rows, in which case the
 * modal never calls this. Kept as a separate command because a conflict body
 * is unbounded and the footer only needs a count.
 */
export async function getConflict(
  projectPath: string,
  conflictId: string,
): Promise<KnowledgeConflictDetail> {
  const raw = await read<unknown>("knowledge_get_conflict", { projectPath, conflictId });
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ...(raw as KnowledgeConflictDetail),
    // The live head is what guards the resolve. Accept the older spelling too:
    // it is the same number under a name that predates the distinction between
    // "head now" and "the revision this conflict was raised against".
    headRevision:
      typeof r.headRevision === "number"
        ? r.headRevision
        : typeof r.currentRevision === "number"
          ? r.currentRevision
          : undefined,
  };
}

/**
 * Commit a decision about a conflict, guarded by the head it was made against.
 *
 * `expectedHeadRevision` is the whole point of the guard: a dialog stays open
 * for as long as it takes to read two documents, and "keep current"/"accept
 * merged" are decisions ABOUT a specific text. If the note moved meanwhile, the
 * service refuses instead of committing a judgement of something the user never
 * saw — and returns the current text so they can decide again.
 *
 * A refusal comes back as `status:"stale"`, NOT as a rejection: the conflict is
 * still open and the caller has work to do, which is a different thing from an
 * operation that failed.
 */
export async function resolveConflict(
  projectPath: string,
  conflictId: string,
  resolution: KnowledgeConflictResolution,
  mergedContent?: string,
  expectedHeadRevision?: number,
): Promise<KnowledgeConflictResolveResult> {
  const raw = await write<unknown>("knowledge_resolve_conflict", {
    projectPath,
    conflictId,
    resolution,
    mergedContent: mergedContent ?? null,
    expectedHeadRevision: expectedHeadRevision ?? null,
  });
  return normalizeResolveResult(raw);
}

/**
 * Read a resolve response without pinning the UI to one backend spelling.
 *
 * A plain `void`/null answer is the historical success shape and must keep
 * meaning success — otherwise adding the guard would turn every working resolve
 * into a phantom "the note changed" loop. `ok`, `merged` and `noop` are the
 * service's other success statuses and must not be mistaken for refusals
 * either: only `conflict`/`stale` (or an explicit `ok:false`) refuse.
 *
 * The service's real refusal nests the fresh text and the new head under
 * `conflict`, and repeats the live head as a top-level `revision`. Reading only
 * the flat spellings degraded a refusal to "notice, but nothing refreshed":
 * the panels stayed stale AND the guard was never re-armed, so the next click
 * re-sent the same expected head and was refused again — a loop with no exit
 * but closing the dialog. Hence both shapes are accepted.
 */
export function normalizeResolveResult(raw: unknown): KnowledgeConflictResolveResult {
  if (!raw || typeof raw !== "object") return { status: "resolved" };
  const r = raw as Record<string, unknown>;
  const refused =
    r.status === "stale" || r.status === "conflict" || r.ok === false || r.stale === true;
  if (!refused) return { status: "resolved" };
  const nested =
    r.conflict && typeof r.conflict === "object" ? (r.conflict as Record<string, unknown>) : null;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  // `revision` last: on the refusal shape it IS the live head, but it is the
  // least specific name here, so anything explicit wins first.
  const head =
    num(r.headRevision) ??
    num(nested?.currentRevision) ??
    num(r.currentRevision) ??
    num(r.revision);
  const current = str(r.currentContent) ?? str(r.current) ?? str(nested?.currentContent);
  return {
    status: "stale",
    headRevision: head,
    // The refusal carries no re-merge, so this is normally undefined — which is
    // the point: the modal drops a preview merged against the old head rather
    // than offering it against text that has moved.
    merged: str(r.merged) ?? str(nested?.merged),
    current,
  };
}

export function createHandoff(projectPath: string, summary?: string): Promise<KnowledgeHandoff> {
  return write<KnowledgeHandoff>("knowledge_create_handoff", {
    projectPath,
    summary: summary ?? null,
  });
}

export function latestHandoff(projectPath: string): Promise<KnowledgeHandoff | null> {
  return read<KnowledgeHandoff | null>("knowledge_latest_handoff", { projectPath });
}

/**
 * Resolve `@`-references into a context package.
 *
 * **Always call this with `record:false`.** Resolving is not delivering, and
 * every caller here resolves BEFORE it knows whether the text will reach an
 * agent — a resolve can time out and be abandoned, or a paste can fail, and a
 * ledger entry written at resolve time would then assert an agent was handed
 * context it never received. Recording is a separate, later step: see
 * `recordContext`, fired once delivery has actually happened.
 *
 * `record:true` remains in the signature only because the backend command still
 * accepts it; nothing in the frontend passes it.
 */
export function resolveRefs(opts: {
  projectPath: string;
  refs: string[];
  record: boolean;
  budgetTokens?: number;
  terminalId?: string;
  agentKind?: string;
  timeoutMs?: number;
}): Promise<ContextPackage> {
  const { projectPath, refs, record, budgetTokens, terminalId, agentKind, timeoutMs } = opts;
  return withTimeout(
    invoke<ContextPackage>("knowledge_resolve_refs", {
      projectPath,
      refs,
      record,
      budgetTokens: budgetTokens ?? null,
      terminalId: terminalId ?? null,
      agentKind: agentKind ?? null,
    }),
    timeoutMs ?? READ_TIMEOUT_MS,
    "knowledge_resolve_refs timed out",
  );
}

/**
 * Log that a pane was ACTUALLY handed these exact entity revisions.
 *
 * Split out from `resolveRefs` deliberately. Recording at resolve time made the
 * ledger lie in two directions: an abandoned resolve (the 1500ms submit
 * deadline) still recorded a delivery that never happened, and a reused preview
 * recorded a fresh re-resolution rather than the older package that was really
 * sent. Both disappear once the caller records what it delivered, after it has
 * delivered it.
 *
 * The revisions come from the package that was sent — never re-resolved here —
 * so the entry describes the bytes the agent got, not the state of the graph a
 * moment later.
 *
 * Fire-and-forget: a failed audit write must never disturb a prompt that has
 * already gone out. The cost is under-recording, which is the honest failure
 * direction — the ledger may miss an entry, but it never invents one.
 */
export function recordContext(opts: {
  projectPath: string;
  entityIds: { entityId: string; revision: number }[];
  terminalId?: string;
  agentKind?: string;
}): Promise<void> {
  return invoke<void>("knowledge_record_context", {
    projectPath: opts.projectPath,
    entityIds: opts.entityIds,
    terminalId: opts.terminalId ?? null,
    agentKind: opts.agentKind ?? null,
  });
}

/** Per-project agent write policy. Lives in the service DB, not localStorage:
 *  it gates agent writes and must survive a cleared browser store. */
export function setPolicy(projectPath: string, policy: KnowledgePolicy): Promise<void> {
  return write<void>("knowledge_set_policy", { projectPath, policy });
}

/** Append-if-absent only. The frontend never edits .gitignore itself. */
/**
 * Detach and delete a project's knowledge — the `.project-memory/` folder AND
 * the event database in app data — to the Recycle Bin. The caller confirms
 * first and calls the store's `reset` after, so the sidebar lands back on the
 * init panel instead of a stale workspace.
 */
export function removeProject(projectPath: string): Promise<void> {
  return write<void>("knowledge_remove", { projectPath });
}

export function appendGitignore(projectPath: string): Promise<void> {
  return write<void>("knowledge_append_gitignore", { projectPath });
}

/**
 * Declare a MADE-authored write before it lands on disk.
 *
 * The watcher cannot tell our save from an agent's, and getting that wrong
 * costs twice: the revision is attributed to the wrong author, and the user
 * gets a "knowledge updated" toast for the edit they just made themselves.
 * Fire-and-forget — a failure here degrades attribution, never the save.
 */
export function markOwnEdit(projectPath: string, filePath: string): Promise<void> {
  return invoke<void>("knowledge_mark_own_edit", { projectPath, filePath });
}

/**
 * Tell the service which agent session is living in which pane.
 *
 * The MCP adapter can prove three things about a caller on its own — which CLI
 * it is, which project it is in, and (via the inherited MADE_PANE_ID) which
 * pane spawned it. What it cannot know is the CLI's OWN session id, because
 * that is discovered by MADE watching transcripts. Joining the two here is what
 * lets a knowledge revision say "Codex, in the session you can resume" instead
 * of just "some Codex".
 *
 * Best-effort by design: a failure costs attribution detail, never a write, so
 * callers fire and forget. Unknown projects are the service's problem to ignore
 * — a pane may well be registered before its project is ever initialized.
 */
export function paneUpdate(update: {
  paneId: string;
  projectPath: string;
  agentKind: string;
  /** Null until MADE has resolved the CLI's own session id. */
  sessionId: string | null;
  status: "active" | "closed";
}): Promise<void> {
  // Flat args, matching every other wrapper in this file.
  return invoke<void>("knowledge_pane_update", { ...update });
}

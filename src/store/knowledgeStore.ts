import { create } from "zustand";
import { useAppStore } from "./index";
import * as api from "../lib/knowledge/api";
import { canonicalProjectKey, sameProjectPath } from "../lib/knowledge/keys";
import { publishNoteIndex, forgetNoteIndex } from "../lib/knowledge/note-index-cache";
import { usableKnowledgePath } from "../lib/knowledge/remote-mirror";
import type {
  KnowledgeChangedPayload,
  KnowledgeConflict,
  KnowledgeNoteDetail,
  KnowledgeNoteMeta,
  KnowledgePolicy,
  KnowledgePresence,
  KnowledgeSearchResult,
  KnowledgeStatus,
} from "../lib/knowledge/types";
import { actorLabel } from "../lib/knowledge/types";

/**
 * Session state for the NexusMind workspace.
 *
 * A MODULE store, not a slice of the root store (the `paneNotificationsStore`
 * precedent). All of it is volatile cache the Rust service owns, so persisting
 * it would only ship stale notes into the next launch; and keeping it out of
 * the ~200-key root store means a note-list refresh does not re-render every
 * component subscribed to the app store. The three real settings live in
 * `knowledgeSlice.ts`, which IS persisted.
 *
 * Every project entry is keyed by `canonicalProjectKey` and remembers the raw
 * path it was opened with, because that raw path is what the commands take.
 */

export interface ProjectKnowledge {
  /** Raw path as the tab knows it — every invoke uses this, never the key. */
  path: string;
  status: KnowledgeStatus;
  readonlyReason?: string;
  revision: number;
  policy: KnowledgePolicy;
  notes: KnowledgeNoteMeta[];
  selectedNoteId: string | null;
  noteDetail: KnowledgeNoteDetail | null;
  searchQuery: string;
  /** `null` means "not searching" — the tree shows. `[]` means "no matches". */
  searchResults: KnowledgeSearchResult[] | null;
  searching: boolean;
  conflicts: KnowledgeConflict[];
  conflictCount: number;
  pendingApprovals: number;
  presence: KnowledgePresence[];
  memoryDir?: string;
  gitignored?: boolean;
  /** Last failure text, shown by the unavailable panel. */
  lastError?: string;
}

export type KnowledgeModal =
  | { kind: "conflict"; projectKey: string; conflictId?: string }
  | { kind: "history"; projectKey: string; entityId: string }
  /** The composer's "what exactly will be appended to my prompt?" view. */
  | { kind: "context-preview"; projectKey: string; projectPath: string; terminalId: string };

export interface KnowledgeToast {
  projectKey: string;
  projectPath: string;
  title: string;
  detail: string;
  entityId?: string;
  /** New on every toast so a repeat of the same text still re-shows. */
  nonce: number;
}

interface KnowledgeStoreState {
  projects: Record<string, ProjectKnowledge>;
  openModal: KnowledgeModal | null;
  lastToast: KnowledgeToast | null;
  /**
   * "Knowledge refs not expanded" — raised by the composer, shown by the host.
   *
   * It lives HERE rather than in PromptComposer because the composer is
   * unmounted by its own submit: with the default (not always-visible) setting,
   * `onClose()` runs in the same batched update as the toast state, so React
   * dropped the child before the toast ever committed and the warning could
   * never appear — silently, in exactly the case it exists to report. The store
   * outlives the pane, so the message survives the composer that raised it.
   *
   * A counter, not a boolean: a second failure must re-show the toast.
   */
  refFallbackNonce: number;

  ensureOpen: (projectPath: string, serverId?: string) => void;
  initialize: (projectPath: string) => Promise<boolean>;
  retry: (projectPath: string) => void;
  reset: (projectPath: string) => void;
  refresh: (projectPath: string) => Promise<void>;
  select: (projectPath: string, entityId: string | null) => void;
  setSearchQuery: (projectPath: string, query: string) => void;
  applyEvent: (payload: KnowledgeChangedPayload) => void;
  invalidateAfterOwnWrite: (projectPath: string) => void;
  setPolicy: (projectPath: string, policy: KnowledgePolicy) => Promise<void>;
  openConflictModal: (projectPath: string, conflictId?: string) => void;
  openHistoryModal: (projectPath: string, entityId: string) => void;
  openContextPreview: (projectPath: string, terminalId: string) => void;
  closeModal: () => void;
  clearToast: () => void;
  raiseRefFallback: () => void;
  clearRefFallback: () => void;
}

const EMPTY_PROJECT: Omit<ProjectKnowledge, "path"> = {
  status: "loading",
  revision: 0,
  policy: "ask",
  notes: [],
  selectedNoteId: null,
  noteDetail: null,
  searchQuery: "",
  searchResults: null,
  searching: false,
  conflicts: [],
  conflictCount: 0,
  pendingApprovals: 0,
  presence: [],
};

/**
 * Attach attempts already running, by key.
 *
 * React 19 StrictMode double-invokes effects in dev, and the sidebar's mount
 * effect plus KnowledgeEngine's active-tab subscription can both ask for the
 * same project in one frame. Without this guard that is two `knowledge_open`
 * calls racing, and the loser's status can overwrite the winner's.
 */
const openInFlight = new Set<string>();
/** Monotonic per-key counters so a slow response cannot overwrite a newer one. */
const selectSeq = new Map<string, number>();
const searchSeq = new Map<string, number>();
const searchTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Trailing coalescer on top of the service's own ~150ms debounce. */
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

const SEARCH_DEBOUNCE_MS = 250;
const EVENT_COALESCE_MS = 100;

export const useKnowledgeStore = create<KnowledgeStoreState>((set, get) => {
  /** Patch one project entry, ignoring events for projects never attached. */
  const patch = (key: string, next: Partial<ProjectKnowledge>) => {
    const existing = get().projects[key];
    if (!existing) return;
    set((s) => ({ projects: { ...s.projects, [key]: { ...s.projects[key], ...next } } }));
  };

  const seed = (key: string, path: string, status: KnowledgeStatus) => {
    set((s) => ({
      projects: {
        ...s.projects,
        [key]: { ...EMPTY_PROJECT, ...(s.projects[key] ?? {}), path, status },
      },
    }));
  };

  /** Fold a status record into an entry, preserving UI-local selection. */
  const applyStatus = (key: string, result: api.StatusResult) => {
    if (!result.ok) {
      patch(key, { status: "unavailable", lastError: result.error });
      return;
    }
    const s = result.status;
    patch(key, {
      status: s.status,
      readonlyReason: s.readonlyReason,
      revision: s.revision,
      policy: s.policy,
      conflictCount: s.conflictCount,
      pendingApprovals: s.pendingApprovals,
      presence: s.presence,
      memoryDir: s.memoryDir,
      gitignored: s.gitignored,
      lastError: undefined,
    });
  };

  const refresh = async (projectPath: string): Promise<void> => {
    const key = canonicalProjectKey(projectPath);
    const entry = get().projects[key];
    if (!entry) return;
    // A project that is not attached has nothing to list, and a remote tab must
    // never invoke at all.
    if (entry.status === "remote-unsupported" || entry.status === "uninitialized") return;

    const statusResult = await api.readProjectStatus(entry.path);
    applyStatus(key, statusResult);
    if (!statusResult.ok || statusResult.status.status === "uninitialized") return;

    const [notes, conflicts] = await Promise.all([
      api.listNotes(entry.path).catch((): KnowledgeNoteMeta[] => []),
      api.listConflicts(entry.path).catch((): KnowledgeConflict[] => []),
    ]);

    // Feeding the composer's index from the same fetch is what keeps the
    // `@note/…` popup instant without a second walk.
    publishNoteIndex(entry.path, notes);

    const current = get().projects[key];
    if (!current) return;
    // Selection survives a refresh unless the note is gone.
    const stillThere = current.selectedNoteId
      ? notes.some((n) => n.id === current.selectedNoteId)
      : false;
    patch(key, {
      notes,
      conflicts,
      conflictCount: conflicts.length,
      selectedNoteId: stillThere ? current.selectedNoteId : null,
      noteDetail: stillThere ? current.noteDetail : null,
    });

    if (stillThere && current.selectedNoteId) {
      // Re-read the detail so backlinks and revision follow the change that
      // triggered this refresh.
      get().select(entry.path, current.selectedNoteId);
    }
  };

  const scheduleRefresh = (key: string, projectPath: string) => {
    const pending = refreshTimers.get(key);
    if (pending) clearTimeout(pending);
    refreshTimers.set(
      key,
      setTimeout(() => {
        refreshTimers.delete(key);
        void refresh(projectPath);
      }, EVENT_COALESCE_MS),
    );
  };

  return {
    projects: {},
    openModal: null,
    lastToast: null,
    refFallbackNonce: 0,

    /**
     * Attach `projectPath`, once per session.
     *
     * Idempotent by design: the sidebar calls it on every mount and the engine
     * calls it on every tab activation, and neither should produce a second
     * open. A project that failed stays failed until the user hits Retry —
     * silently re-attempting on every tab switch would hammer a broken service.
     */
    ensureOpen: (projectPath, serverId) => {
      if (!projectPath) return;
      const key = canonicalProjectKey(projectPath);
      if (!key) return;

      // SSH projects. Callers are expected to have resolved the path already
      // (`resolveMirror`), so reaching here with a `serverId` means either an
      // unmirrored server — nothing on this machine to open, say so and invoke
      // nothing — or a caller that forgot. Resolving again rather than trusting
      // is the cheap half of that: it costs a prefix match and it keeps a
      // proven link working from any entry point.
      if (serverId) {
        const local = usableKnowledgePath(projectPath, serverId);
        if (!local) {
          const existing = get().projects[key];
          if (existing?.status === "remote-unsupported") return;
          seed(key, projectPath, "remote-unsupported");
          return;
        }
        get().ensureOpen(local);
        return;
      }

      const existing = get().projects[key];
      if (existing && existing.status !== "loading") return;
      if (openInFlight.has(key)) return;
      openInFlight.add(key);
      seed(key, projectPath, "loading");

      void (async () => {
        try {
          const result = await api.openProject(projectPath, false);
          applyStatus(key, result);
          if (result.ok && result.status.status !== "uninitialized") {
            await refresh(projectPath);
          }
        } finally {
          openInFlight.delete(key);
        }
      })();
    },

    /**
     * The ONLY path that may create `.project-memory/`. Driven by the explicit
     * "Initialize NexusMind" button — never by attaching, never by a refresh.
     */
    initialize: async (projectPath) => {
      const key = canonicalProjectKey(projectPath);
      if (!key) return false;
      seed(key, projectPath, "loading");
      const result = await api.openProject(projectPath, true);
      applyStatus(key, result);
      if (!result.ok) return false;
      await refresh(projectPath);
      return true;
    },

    retry: (projectPath) => {
      const key = canonicalProjectKey(projectPath);
      const entry = get().projects[key];
      if (!entry) return;
      openInFlight.delete(key);
      forgetNoteIndex(projectPath);
      patch(key, { status: "loading", lastError: undefined });
      void (async () => {
        openInFlight.add(key);
        try {
          const result = await api.openProject(entry.path, false);
          applyStatus(key, result);
          if (result.ok && result.status.status !== "uninitialized") await refresh(entry.path);
        } finally {
          openInFlight.delete(key);
        }
      })();
    },

    /**
     * Forget everything and re-attach from nothing. The remove-NexusMind path:
     * after `knowledge_remove` the disk is empty, but `retry` would only PATCH
     * the existing entry — stale notes and selection survive a merge — so the
     * entry is dropped outright and `ensureOpen` seeds a fresh one, which comes
     * back `uninitialized` and lands on the init panel.
     */
    reset: (projectPath) => {
      const key = canonicalProjectKey(projectPath);
      if (!key) return;
      openInFlight.delete(key);
      forgetNoteIndex(projectPath);
      set((s) => {
        const projects = { ...s.projects };
        delete projects[key];
        return { projects };
      });
      get().ensureOpen(projectPath);
    },

    refresh,

    /**
     * Select a note and load its detail. Sequence-guarded: clicking down a list
     * fires several reads, and without the guard the slowest one wins.
     */
    select: (projectPath, entityId) => {
      const key = canonicalProjectKey(projectPath);
      const entry = get().projects[key];
      if (!entry) return;
      const seq = (selectSeq.get(key) ?? 0) + 1;
      selectSeq.set(key, seq);

      if (!entityId) {
        patch(key, { selectedNoteId: null, noteDetail: null });
        return;
      }
      patch(key, { selectedNoteId: entityId, noteDetail: null });
      void api
        .getNote(entry.path, entityId)
        .then((detail) => {
          if (selectSeq.get(key) !== seq) return;
          patch(key, { noteDetail: detail });
        })
        .catch(() => {
          if (selectSeq.get(key) !== seq) return;
          // The row stays selected with no detail panel rather than throwing —
          // a note whose detail cannot be read is still openable on disk.
          patch(key, { noteDetail: null });
        });
    },

    /** Debounced full-text search. Empty query restores the tree. */
    setSearchQuery: (projectPath, query) => {
      const key = canonicalProjectKey(projectPath);
      const entry = get().projects[key];
      if (!entry) return;

      const pending = searchTimers.get(key);
      if (pending) clearTimeout(pending);

      const trimmed = query.trim();
      if (!trimmed) {
        searchSeq.set(key, (searchSeq.get(key) ?? 0) + 1);
        patch(key, { searchQuery: query, searchResults: null, searching: false });
        return;
      }

      patch(key, { searchQuery: query, searching: true });
      const seq = (searchSeq.get(key) ?? 0) + 1;
      searchSeq.set(key, seq);
      searchTimers.set(
        key,
        setTimeout(() => {
          searchTimers.delete(key);
          void api
            .searchKnowledge(entry.path, trimmed, 50)
            .then((results) => {
              if (searchSeq.get(key) !== seq) return;
              patch(key, { searchResults: results, searching: false });
            })
            .catch(() => {
              if (searchSeq.get(key) !== seq) return;
              patch(key, { searchResults: [], searching: false });
            });
        }, SEARCH_DEBOUNCE_MS),
      );
    },

    /**
     * Fold one `made:knowledge-changed` event.
     *
     * Events broadcast to every webview and cover projects the UI may never
     * have attached (an MCP client can be writing to one), so an unknown key is
     * simply ignored. Matching falls back to the raw path because a folding
     * mismatch between Rust and TS must not silently freeze the sidebar.
     */
    applyEvent: (payload) => {
      const projects = get().projects;
      let key = payload.projectKey;
      if (!projects[key]) {
        const fallback = Object.keys(projects).find((k) =>
          sameProjectPath(projects[k].path, payload.projectPath),
        );
        if (!fallback) return;
        key = fallback;
      }
      const entry = projects[key];
      if (entry.status === "remote-unsupported") return;

      if (payload.kinds.includes("presence")) {
        // Presence alone is not a knowledge change: patch it and do not refetch.
        patch(key, { conflictCount: payload.openConflicts });
      }

      const revisionMoved = payload.revision > entry.revision;
      const structural = payload.kinds.some(
        (k) => k === "note" || k === "conflict" || k === "handoff" || k === "approval" || k === "status",
      );
      if (revisionMoved || structural) {
        // Take the revision straight from the payload rather than waiting for
        // the debounced refresh's status read. It is the composer's staleness
        // gate: while this lagged, a parked reference preview resolved at an
        // older revision still compared equal to "current" and was sent as if
        // fresh. `revisionMoved` is read above, before this patch, so the
        // refresh decision is unaffected.
        patch(key, {
          conflictCount: payload.openConflicts,
          ...(revisionMoved ? { revision: payload.revision } : {}),
        });
        scheduleRefresh(key, entry.path);
      }

      maybeToast(entry, key, payload, set, get);
    },

    /** Refresh right after a UI-invoked mutation — do not wait for the event. */
    invalidateAfterOwnWrite: (projectPath) => {
      void refresh(projectPath);
    },

    setPolicy: async (projectPath, policy) => {
      const key = canonicalProjectKey(projectPath);
      const entry = get().projects[key];
      if (!entry) return;
      const previous = entry.policy;
      patch(key, { policy });
      try {
        await api.setPolicy(entry.path, policy);
      } catch (e) {
        // The service is the authority on policy; a failed write must not leave
        // the control showing a permission the agent does not actually have.
        patch(key, { policy: previous, lastError: api.knowledgeErrorText(e) });
        throw e;
      }
    },

    openConflictModal: (projectPath, conflictId) =>
      set({ openModal: { kind: "conflict", projectKey: canonicalProjectKey(projectPath), conflictId } }),

    openHistoryModal: (projectPath, entityId) =>
      set({ openModal: { kind: "history", projectKey: canonicalProjectKey(projectPath), entityId } }),

    openContextPreview: (projectPath, terminalId) =>
      set({
        openModal: {
          kind: "context-preview",
          projectKey: canonicalProjectKey(projectPath),
          projectPath,
          terminalId,
        },
      }),

    closeModal: () => set({ openModal: null }),

    clearToast: () => set({ lastToast: null }),

    raiseRefFallback: () => set((s) => ({ refFallbackNonce: s.refFallbackNonce + 1 })),

    clearRefFallback: () => set({ refFallbackNonce: 0 }),
  };
});

/**
 * Decide whether a change deserves a toast, and raise one if so.
 *
 * Every suppression rule here answers the same question — "would this tell the
 * user something they do not already know?":
 *
 *  - the setting is off;
 *  - the user made the change themselves (the service attributes MADE-origin
 *    imports as `user`, which is what `knowledge_mark_own_edit` buys us);
 *  - they are already looking at the thing that changed;
 *  - the app is not on screen at all, so a toast would only be seen later,
 *    out of context.
 *
 * A burst collapses into one card. The overlay clips popups to their rendered
 * rect, so a card that grew a line after opening would need region churn under
 * the pointer — the count is decided before the toast exists.
 */
function maybeToast(
  entry: ProjectKnowledge,
  key: string,
  payload: KnowledgeChangedPayload,
  set: (partial: Partial<KnowledgeStoreState>) => void,
  get: () => KnowledgeStoreState,
): void {
  const app = useAppStore.getState();
  if (!app.knowledgeNotifEnabled) return;
  if (!payload.actor || payload.actor.kind === "user") return;
  if (!payload.kinds.includes("note") && !payload.kinds.includes("conflict")) return;
  if (payload.entityIds.length === 0 && !payload.truncated) return;

  const changedCount = payload.entityIds.length + (payload.truncated ? 1 : 0);
  const singleId = changedCount === 1 ? payload.entityIds[0] : undefined;

  // Already looking at it: the note is selected, its sidebar is open on the
  // knowledge tab, this project is the active tab, and the window is focused.
  if (singleId && entry.selectedNoteId === singleId && app.appWindowFocused) {
    const activeTab = app.tabs.find((t) => t.id === app.activeTabId);
    const activeIsThis = !!activeTab && sameProjectPath(activeTab.workingDir, entry.path);
    if (activeIsThis && app.sidebarOpen && app.sidebarTab === "knowledge") return;
  }

  const note = singleId ? entry.notes.find((n) => n.id === singleId) : undefined;
  const fileName = note?.filePath.split(/[\\/]/).pop();
  const detail =
    changedCount === 1
      ? note
        ? fileName
          ? `${fileName} · ${note.title}`
          : note.title
        : "1 change"
      : `${changedCount} changes`;

  set({
    lastToast: {
      projectKey: key,
      projectPath: entry.path,
      title: `Knowledge updated by ${actorLabel(payload.actor)}`,
      detail,
      entityId: singleId,
      nonce: (get().lastToast?.nonce ?? 0) + 1,
    },
  });
}

/** Read one project's entry without subscribing. */
export function knowledgeProjectOf(projectPath: string): ProjectKnowledge | undefined {
  return useKnowledgeStore.getState().projects[canonicalProjectKey(projectPath)];
}

/**
 * Why a mutating affordance is unavailable right now, or null when it is fine.
 *
 * Six surfaces can mutate knowledge (sidebar buttons, note rows, context menus,
 * the palette, settings, modals) and each of them has the same four ways to be
 * wrong. Centralizing the reason string is what keeps them from drifting into
 * four different explanations of the same state — or worse, a dead control.
 */
export function knowledgeBlockedReason(projectPath: string): string | null {
  const entry = knowledgeProjectOf(projectPath);
  if (!entry) return "Knowledge is not attached to this project";
  if (entry.status === "readonly") {
    return entry.readonlyReason || "Knowledge is read-only in this instance";
  }
  return knowledgeReadBlockedReason(projectPath);
}

/**
 * The same question for a READ (refresh, search, open, insert into a pane).
 *
 * Read-only is not a blocker here — a follower instance can do all of it — and
 * conflating the two would grey out Refresh on exactly the instance that most
 * needs it.
 */
export function knowledgeReadBlockedReason(projectPath: string): string | null {
  const entry = knowledgeProjectOf(projectPath);
  if (!entry) return "Knowledge is not attached to this project";
  switch (entry.status) {
    case "remote-unsupported":
      return "Knowledge is local-only — SSH projects are not supported yet";
    case "uninitialized":
      return "Initialize knowledge for this project first";
    case "unavailable":
      return "The knowledge service is not available";
    case "loading":
      return "Still opening knowledge…";
    default:
      return null;
  }
}

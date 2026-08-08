import type { StateCreator } from "zustand";

/**
 * The ONLY NexusMind state that persists.
 *
 * Everything else the knowledge workspace shows — notes, revisions, conflicts,
 * presence, the write policy — is served by the Rust service and lives in
 * `knowledgeStore.ts`, deliberately outside the persisted root store. Two
 * reasons: it is volatile server-derived cache that would go stale across a
 * restart, and the write policy in particular MUST survive a cleared
 * localStorage because it gates what agents are allowed to write.
 *
 * So only three fields land here, and all three are user preferences.
 */
export interface KnowledgeSlice {
  /** Attach a project's knowledge when its tab is activated. Never scaffolds:
   *  attaching an uninitialized project still shows the Initialize panel. */
  knowledgeAutoAttach: boolean;
  /** Show the bottom-right toast when an agent changes shared memory. */
  knowledgeNotifEnabled: boolean;
  /** Projects where the user chose "Not now" on the first-run panel, keyed by
   *  `canonicalProjectKey`. The panel collapses to one quiet line instead of
   *  re-pitching the feature on every visit. */
  knowledgeInitDismissed: Record<string, true>;

  setKnowledgeAutoAttach: (v: boolean) => void;
  setKnowledgeNotifEnabled: (v: boolean) => void;
  dismissKnowledgeInit: (projectKey: string) => void;
  /** Removing NexusMind clears the dismissal: whoever deliberately deleted the
   *  workspace gets the full init panel back, not the collapsed one-liner. */
  undismissKnowledgeInit: (projectKey: string) => void;
}

export const createKnowledgeSlice: StateCreator<KnowledgeSlice, [], [], KnowledgeSlice> = (set) => ({
  knowledgeAutoAttach: true,
  knowledgeNotifEnabled: true,
  knowledgeInitDismissed: {},

  setKnowledgeAutoAttach: (v) => set({ knowledgeAutoAttach: v }),
  setKnowledgeNotifEnabled: (v) => set({ knowledgeNotifEnabled: v }),
  dismissKnowledgeInit: (projectKey) =>
    set((state) => ({
      knowledgeInitDismissed: { ...state.knowledgeInitDismissed, [projectKey]: true },
    })),
  undismissKnowledgeInit: (projectKey) =>
    set((state) => {
      if (!state.knowledgeInitDismissed[projectKey]) return state;
      const next = { ...state.knowledgeInitDismissed };
      delete next[projectKey];
      return { knowledgeInitDismissed: next };
    }),
});

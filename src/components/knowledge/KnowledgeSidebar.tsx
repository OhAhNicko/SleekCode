import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import LoadingDots from "../LoadingDots";
import { useAppStore } from "../../store";
import {
  useKnowledgeStore,
  knowledgeBlockedReason,
  type ProjectKnowledge,
} from "../../store/knowledgeStore";
import * as api from "../../lib/knowledge/api";
import { canonicalProjectKey, MEMORY_DIR_NAME } from "../../lib/knowledge/keys";
import { resolveMirror, revalidateMirrorOnce } from "../../lib/knowledge/remote-mirror";
import { CORE_NOTE_TYPES, knowledgeRefFor } from "../../lib/knowledge/types";
import type { KnowledgeNoteMeta } from "../../lib/knowledge/types";
import { registerSurfaceActions, unregisterSurfaceActions } from "../../lib/surface-actions";
import { promptForInput, confirmAction, chooseOption } from "../../lib/prompt-modal";
import { resolveCaretTerminalId } from "../../lib/clipboard-insert";
import { pasteTextToTerminal } from "../../lib/terminal-paste";
import KnowledgeSearchBox from "./KnowledgeSearchBox";
import KnowledgeCoreSection from "./KnowledgeCoreSection";
import KnowledgeNotesTree, { KnowledgeSearchRow, KnowledgeEmptyLine } from "./KnowledgeNotesTree";
import KnowledgeNoteInfo from "./KnowledgeNoteInfo";
import KnowledgeInitPanel from "./KnowledgeInitPanel";
import KnowledgeRemotePanel from "./KnowledgeRemotePanel";
import KnowledgeJiraPanel from "./KnowledgeJiraPanel";
import KnowledgeReadonlyBanner from "./KnowledgeReadonlyBanner";
import KnowledgeHandoffActions from "./KnowledgeHandoffActions";
import KnowledgeAgentAccess from "./KnowledgeAgentAccess";
import KnowledgeFooter from "./KnowledgeFooter";

/**
 * The NexusMind workspace, inside the existing 260px sidebar slot.
 *
 * One app-level instance bound to the ACTIVE tab (exactly like FileExplorer),
 * which is what sidesteps the every-tab-stays-mounted hazard: there is only
 * ever one of these, so there is only ever one set of surface-action
 * registrations and one keyboard owner.
 *
 * Every mutating affordance in here reads the same `knowledgeBlockedReason`.
 * Six surfaces can mutate knowledge and each has four ways to be unavailable;
 * routing all of them through one function is what keeps a read-only instance
 * from shipping one dead button among eleven correct ones.
 */
interface Props {
  /** The TAB's working directory. On an SSH tab this is a path on the server,
   *  which is why nothing below uses it directly — see `rootDir`. */
  tabDir: string;
  serverId?: string;
  /** Jira tabs get no NexusMind offer — but an already-initialized repo still
   *  attaches and works. See the probe in the mount effect. */
  isJiraProject?: boolean;
  onOpenFile: (filePath: string, lineNumber?: number) => void;
}

/** Insert into an agent pane needs a pane that can receive a prompt. */
function agentTargetOrReason(): { terminalId: string } | { reason: string } {
  const terminalId = resolveCaretTerminalId();
  if (!terminalId) return { reason: "No active agent pane" };
  const term = useAppStore.getState().terminals[terminalId];
  const isAgent = term?.type === "claude" || term?.type === "codex" || term?.type === "gemini";
  if (!isAgent) return { reason: "No active agent pane" };
  return { terminalId };
}

export default function KnowledgeSidebar({ tabDir, serverId, isJiraProject, onOpenFile }: Props) {
  // Resolve the tab's directory to a LOCAL one exactly once, here. On a local
  // tab that is the identity; on an SSH tab whose folder is a proven mirror of
  // a local folder it is the local twin, and every line below — the store key,
  // every `api.*` call, the context-menu root — then works on a local path with
  // no idea a server was involved. Empty when a remote tab has no usable link,
  // which the status routing turns into the link panel before anything runs.
  //
  // Subscribing to `servers` keeps this reactive: linking a folder must light
  // the sidebar up on that click, not on whatever render happens next.
  const servers = useAppStore((s) => s.servers);
  const mirror = useMemo(
    () => resolveMirror(tabDir, serverId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabDir, serverId, servers],
  );
  /**
   * A link that no longer holds — the share was unmounted or re-pointed since
   * it was proven. Costs nothing to check (a byte compare of a file both sides
   * already have, memoised per session) and catches the one failure a stored
   * link can develop on its own: the sidebar happily showing memory that the
   * agent on the server can no longer reach.
   */
  const [staleLink, setStaleLink] = useState(false);

  const linkedPath = mirror.kind === "local" || mirror.kind === "linked" ? mirror.path : "";
  const rootDir = staleLink ? "" : linkedPath;

  const ensureOpen = useKnowledgeStore((s) => s.ensureOpen);
  const initialize = useKnowledgeStore((s) => s.initialize);
  const retry = useKnowledgeStore((s) => s.retry);
  const select = useKnowledgeStore((s) => s.select);
  const setSearchQuery = useKnowledgeStore((s) => s.setSearchQuery);
  const invalidate = useKnowledgeStore((s) => s.invalidateAfterOwnWrite);
  const openConflictModal = useKnowledgeStore((s) => s.openConflictModal);
  const openHistoryModal = useKnowledgeStore((s) => s.openHistoryModal);

  const key = canonicalProjectKey(rootDir);
  const project = useKnowledgeStore((s) => s.projects[key]) as ProjectKnowledge | undefined;

  const autoAttach = useAppStore((s) => s.knowledgeAutoAttach);
  const dismissed = useAppStore((s) => !!s.knowledgeInitDismissed[key]);
  const dismissInit = useAppStore((s) => s.dismissKnowledgeInit);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** True on the render right after "Initialize NexusMind" succeeded — the one
   *  time the Agents section walks the CLIs sequentially instead of at once. */
  const [freshInit, setFreshInit] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Whether an agent pane can receive an insert has to be REACTIVE: focusing a
  // shell pane must grey the button out on that click, not on whatever render
  // happens to come next. Both selectors return primitives, so subscribing here
  // costs nothing.
  const activeTerminalId = useAppStore(
    (s) => Object.values(s.terminals).find((t) => t.isActive)?.id ?? "",
  );
  const activeTerminalType = useAppStore(
    (s) => Object.values(s.terminals).find((t) => t.isActive)?.type ?? "",
  );
  const activeTabId = useAppStore((s) => s.activeTabId);
  const liveAgentTarget = useMemo(
    () => agentTargetOrReason(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTerminalId, activeTerminalType, activeTabId],
  );

  /** Jira gate: null = probing, true = repo has knowledge (attach as usual),
   *  false = none — show the not-offered panel and touch nothing. */
  const [jiraHasMemory, setJiraHasMemory] = useState<boolean | null>(null);

  // Confirm a stored link still holds. Only `false` acts — `null` means the
  // project has no memory yet, which is not evidence of anything.
  //
  // The reset on the first line is load-bearing. There is ONE of these sidebars
  // for the whole app and it re-targets on every tab switch, so a verdict left
  // over from the previous tab would blank out the next one — including a plain
  // local tab, which would then be told to link a folder it does not need.
  useEffect(() => {
    setStaleLink(false);
    if (mirror.kind !== "linked" || !serverId) return;
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;
    let cancelled = false;
    void revalidateMirrorOnce(server, mirror.path, tabDir).then((ok) => {
      if (!cancelled) setStaleLink(ok === false);
    });
    return () => {
      cancelled = true;
    };
  }, [mirror, serverId, servers, tabDir]);

  useEffect(() => {
    if (!rootDir) return;
    if (isJiraProject) {
      // Probe, never offer: `probeInitialized` is a pure disk stat that opens
      // nothing, so an uninitialized repo costs no database and no watcher.
      let cancelled = false;
      setJiraHasMemory(null);
      void api.probeInitialized(rootDir).then((initialized) => {
        if (cancelled) return;
        setJiraHasMemory(initialized);
        if (initialized) ensureOpen(rootDir);
      });
      return () => {
        cancelled = true;
      };
    }
    if (autoAttach) ensureOpen(rootDir);
  }, [ensureOpen, rootDir, autoAttach, isJiraProject]);

  const status = project?.status ?? "loading";
  const blocked = knowledgeBlockedReason(rootDir);
  const notes = project?.notes ?? [];
  const selectedId = project?.selectedNoteId ?? null;
  const searchResults = project?.searchResults ?? null;

  const coreNotes = useMemo(() => {
    const seen = new Set<string>();
    const out: KnowledgeNoteMeta[] = [];
    for (const type of CORE_NOTE_TYPES) {
      const hit = notes.find((n) => n.type === type);
      if (hit && !seen.has(hit.id)) {
        seen.add(hit.id);
        out.push(hit);
      }
    }
    return out;
  }, [notes]);

  const freeNotes = useMemo(
    () =>
      notes
        .filter((n) => n.type === "note" && !n.archived)
        .sort((a, b) => a.title.localeCompare(b.title)),
    [notes],
  );

  const conflictedIds = useMemo(
    () => new Set((project?.conflicts ?? []).map((c) => c.entityId)),
    [project?.conflicts],
  );

  /** Flat navigation order — whatever the list is currently showing. */
  const navIds = useMemo(() => {
    if (searchResults) return searchResults.map((r) => r.entityId);
    return [...coreNotes.map((n) => n.id), ...freeNotes.map((n) => n.id)];
  }, [searchResults, coreNotes, freeNotes]);

  const noteById = useCallback(
    (entityId: string) => notes.find((n) => n.id === entityId),
    [notes],
  );

  const pathOf = useCallback(
    (entityId: string) =>
      noteById(entityId)?.filePath ??
      searchResults?.find((r) => r.entityId === entityId)?.filePath ??
      "",
    [noteById, searchResults],
  );

  // ── Actions ─────────────────────────────────────────────────────────────

  const openNote = useCallback(
    (entityId: string, preview?: boolean) => {
      const filePath = pathOf(entityId);
      if (!filePath) return;
      if (preview) {
        window.dispatchEvent(
          new CustomEvent("made:open-file", { detail: { filePath, markdownPreview: true } }),
        );
        return;
      }
      onOpenFile(filePath);
    },
    [pathOf, onOpenFile],
  );

  const runMutation = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true);
      setActionError(null);
      try {
        await work();
      } catch (e) {
        setActionError(api.knowledgeErrorText(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const newNote = useCallback(() => {
    if (blocked) return;
    void (async () => {
      const title = await promptForInput({
        title: "New note",
        label: "Title",
        confirmLabel: "Create",
        detail: `Creates a markdown file under ${MEMORY_DIR_NAME}/notes/.`,
      });
      if (title === null) return;
      const trimmed = title.trim();
      if (!trimmed) return;
      await runMutation(async () => {
        const meta = await api.createNote(rootDir, trimmed);
        invalidate(rootDir);
        select(rootDir, meta.id);
        if (meta.filePath) onOpenFile(meta.filePath);
      });
    })();
  }, [blocked, rootDir, runMutation, invalidate, select, onOpenFile]);

  const renameNote = useCallback(
    (entityId: string) => {
      const note = noteById(entityId);
      if (!note || blocked) return;
      void (async () => {
        const title = await promptForInput({
          title: "Rename note",
          label: "Title",
          initialValue: note.title,
          confirmLabel: "Rename",
        });
        if (title === null) return;
        const trimmed = title.trim();
        if (!trimmed || trimmed === note.title) return;
        await runMutation(async () => {
          await api.renameNote(rootDir, entityId, trimmed, note.revision);
          invalidate(rootDir);
        });
      })();
    },
    [noteById, blocked, rootDir, runMutation, invalidate],
  );

  const archiveNote = useCallback(
    (entityId: string) => {
      const note = noteById(entityId);
      if (!note || blocked) return;
      void (async () => {
        const ok = await confirmAction({
          title: `Archive "${note.title}"?`,
          detail: "The note stops appearing in the list. Nothing is deleted and its history stays.",
          confirmLabel: "Archive",
        });
        if (!ok) return;
        await runMutation(async () => {
          await api.archiveNote(rootDir, entityId, note.revision);
          if (selectedId === entityId) select(rootDir, null);
          invalidate(rootDir);
        });
      })();
    },
    [noteById, blocked, rootDir, runMutation, invalidate, select, selectedId],
  );

  const copyRef = useCallback(
    (entityId: string) => {
      const note = noteById(entityId);
      if (!note) return;
      void navigator.clipboard.writeText(knowledgeRefFor(note.type, note.slug)).catch(() => {});
    },
    [noteById],
  );

  /**
   * Hand a note to the agent pane the caret is in — as a PASTE, never a submit.
   * The user reads what landed and presses Enter themselves; an agent prompt
   * that sends itself is one the user never got to correct.
   */
  const insertIntoAgent = useCallback(
    (entityId: string) => {
      const note = noteById(entityId);
      if (!note || blocked) return;
      const target = agentTargetOrReason();
      if ("reason" in target) return;
      void runMutation(async () => {
        const agentKind = useAppStore.getState().terminals[target.terminalId]?.type;
        // Resolve without recording: a paste can still fail (a pane whose PTY
        // has gone), and an audit entry written here would claim a delivery
        // that never happened.
        const pkg = await api.resolveRefs({
          projectPath: rootDir,
          refs: [knowledgeRefFor(note.type, note.slug)],
          record: false,
          terminalId: target.terminalId,
          agentKind,
        });
        const pasted = pasteTextToTerminal(target.terminalId, pkg.renderedPromptContext);
        if (!pasted) return;
        // Delivered — now the ledger can say so, with the revisions that went.
        void api
          .recordContext({
            projectPath: rootDir,
            entityIds: pkg.sources.map((s) => ({ entityId: s.entityId, revision: s.revision })),
            terminalId: target.terminalId,
            agentKind,
          })
          .catch(() => {});
      });
    },
    [noteById, blocked, rootDir, runMutation],
  );

  const createHandoff = useCallback(() => {
    if (blocked) return;
    void runMutation(async () => {
      const handoff = await api.createHandoff(rootDir);
      invalidate(rootDir);
      if (!handoff.entityId) return;
      select(rootDir, handoff.entityId);
      // Open it too: a handoff exists to be read by a human before another
      // agent acts on it, so landing in the file is the useful end state.
      const filePath = useKnowledgeStore
        .getState()
        .projects[key]?.notes.find((n) => n.id === handoff.entityId)?.filePath;
      if (filePath) onOpenFile(filePath);
    });
  }, [blocked, rootDir, runMutation, invalidate, select, key, onOpenFile]);

  const continueHandoff = useCallback(() => {
    const target = agentTargetOrReason();
    if ("reason" in target) return;
    void runMutation(async () => {
      const handoff = await api.latestHandoff(rootDir);
      if (!handoff) {
        setActionError("No handoffs yet");
        return;
      }
      pasteTextToTerminal(
        target.terminalId,
        `Continue from the latest handoff:\n\n${handoff.renderedMarkdown}`,
      );
    });
  }, [rootDir, runMutation]);

  const revealFolder = useCallback(() => {
    const path = project?.memoryDir;
    if (!path) return;
    void invoke("reveal_in_explorer", { path }).catch(() => {});
  }, [project?.memoryDir]);

  /** File-row parity with the Files tab: select this note's file in Explorer. */
  const revealNote = useCallback(
    (entityId: string) => {
      const filePath = pathOf(entityId);
      if (!filePath) return;
      void invoke("reveal_in_explorer", { path: filePath }).catch(() => {});
    },
    [pathOf],
  );

  const addGitignore = useCallback(() => {
    if (blocked) return;
    void runMutation(async () => {
      await api.appendGitignore(rootDir);
      invalidate(rootDir);
    });
  }, [blocked, rootDir, runMutation, invalidate]);

  const refreshNow = useCallback(() => {
    void runMutation(async () => {
      await api.rescanProject(rootDir).catch(() => {});
      invalidate(rootDir);
    });
  }, [rootDir, runMutation, invalidate]);

  /**
   * Remove NexusMind from this project — the undo of Initialize.
   *
   * Deletion happens in one Rust command (`knowledge_remove`) so the ordering
   * is owned in one place: detach, then folder, then the app-data database —
   * everything to the Recycle Bin, nothing permanent. Afterwards the store
   * entry is dropped and re-attached, which comes back `uninitialized`, and
   * the dismissal is cleared so the FULL init panel returns: whoever
   * deliberately removed the workspace should see the real offer again, not
   * the collapsed one-liner.
   */
  const removeProject = useCallback(() => {
    if (blocked) return;
    void (async () => {
      const ok = await confirmAction({
        title: "Remove NexusMind from this project?",
        detail: `Deletes ${MEMORY_DIR_NAME}/ and this project's knowledge history. Everything goes to the Recycle Bin. Agents lose access until you initialize again.`,
        confirmLabel: "Remove",
        danger: true,
      });
      if (!ok) return;
      await runMutation(async () => {
        await api.removeProject(rootDir);
        useAppStore.getState().undismissKnowledgeInit(key);
        useKnowledgeStore.getState().reset(rootDir);
      });
    })();
  }, [blocked, rootDir, key, runMutation]);

  /**
   * Initialize, then offer to keep the folder out of Git.
   *
   * The offer comes AFTER the folder exists, not before: at that point the
   * user can see what they are deciding about, and declining leaves a working
   * feature rather than an aborted setup.
   */
  const doInitialize = useCallback(async () => {
    // BEFORE the call: the store update inside `initialize` mounts the
    // workspace, and the Agents section reads this flag at that mount. Set
    // afterwards it loses the race and the first-run sequence never plays.
    setFreshInit(true);
    const ok = await initialize(rootDir);
    if (!ok) {
      setFreshInit(false);
      const entry = useKnowledgeStore.getState().projects[key];
      throw new Error(entry?.lastError || "Could not initialize knowledge for this project");
    }
    const choice = await chooseOption({
      title: "Keep knowledge out of Git?",
      detail: "Shared memory is plain markdown — committing it is a real option.",
      choices: [
        {
          id: "ignore",
          label: `Add ${MEMORY_DIR_NAME}/ to .gitignore`,
          detail: "MADE appends one line to .gitignore.",
        },
        {
          id: "commit",
          label: "Commit knowledge with the repo",
          detail: "No changes to .gitignore.",
        },
      ],
    });
    if (choice === "ignore") {
      await api.appendGitignore(rootDir).catch(() => {});
      invalidate(rootDir);
    }
  }, [initialize, rootDir, key, invalidate]);

  // ── Context-menu handlers ───────────────────────────────────────────────
  //
  // Registered through the surface registry rather than as `made:*` events: a
  // provider that finds no registration disables its row with a reason, where
  // a missing event listener would render a row that silently does nothing.
  const handlersRef = useRef({
    openNote,
    renameNote,
    archiveNote,
    copyRef,
    insertIntoAgent,
    newNote,
    createHandoff,
    continueHandoff,
    revealFolder,
    revealNote,
    addGitignore,
    refreshNow,
    removeProject,
    openHistoryModal,
    rootDir,
  });
  handlersRef.current = {
    openNote,
    renameNote,
    archiveNote,
    copyRef,
    insertIntoAgent,
    newNote,
    createHandoff,
    continueHandoff,
    revealFolder,
    revealNote,
    addGitignore,
    refreshNow,
    removeProject,
    openHistoryModal,
    rootDir,
  };

  useEffect(() => {
    registerSurfaceActions("knowledge-note", {
      open: (id) => handlersRef.current.openNote(id),
      openPreview: (id) => handlersRef.current.openNote(id, true),
      insertIntoAgent: (id) => handlersRef.current.insertIntoAgent(id),
      copyRef: (id) => handlersRef.current.copyRef(id),
      rename: (id) => handlersRef.current.renameNote(id),
      archive: (id) => handlersRef.current.archiveNote(id),
      history: (id) => handlersRef.current.openHistoryModal(handlersRef.current.rootDir, id),
      reveal: (id) => handlersRef.current.revealNote(id),
    });
    registerSurfaceActions("knowledge", {
      newNote: () => handlersRef.current.newNote(),
      createHandoff: () => handlersRef.current.createHandoff(),
      continueHandoff: () => handlersRef.current.continueHandoff(),
      refresh: () => handlersRef.current.refreshNow(),
      revealFolder: () => handlersRef.current.revealFolder(),
      addGitignore: () => handlersRef.current.addGitignore(),
      removeProject: () => handlersRef.current.removeProject(),
    });
    return () => {
      unregisterSurfaceActions("knowledge-note");
      unregisterSurfaceActions("knowledge");
    };
  }, []);

  // ── Keyboard navigation ─────────────────────────────────────────────────
  //
  // Scoped to the list container, never to `window`: a keydown listener on the
  // window fires for every mounted project tab and steals arrow keys from
  // whatever the user is actually typing into.
  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (navIds.length === 0) return;
      const currentIdx = selectedId ? navIds.indexOf(selectedId) : -1;

      const moveTo = (idx: number) => {
        e.preventDefault();
        const clamped = Math.max(0, Math.min(navIds.length - 1, idx));
        const id = navIds[clamped];
        select(rootDir, id);
        listRef.current
          ?.querySelector(`[data-knowledge-row="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      };

      switch (e.key) {
        case "ArrowDown":
          moveTo(currentIdx + 1);
          return;
        case "ArrowUp":
          moveTo(currentIdx <= 0 ? 0 : currentIdx - 1);
          return;
        case "Home":
          moveTo(0);
          return;
        case "End":
          moveTo(navIds.length - 1);
          return;
        case "Enter":
          if (selectedId) {
            e.preventDefault();
            openNote(selectedId);
          }
          return;
        case "ContextMenu": {
          if (!selectedId) return;
          const el = listRef.current?.querySelector(
            `[data-knowledge-row="${CSS.escape(selectedId)}"]`,
          ) as HTMLElement | null;
          if (!el) return;
          e.preventDefault();
          const rect = el.getBoundingClientRect();
          el.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              clientX: Math.round(rect.left + 12),
              clientY: Math.round(rect.top + rect.height / 2),
            }),
          );
          return;
        }
      }
    },
    [navIds, selectedId, select, rootDir, openNote],
  );

  const focusList = useCallback(() => {
    listRef.current?.focus();
    if (!selectedId && navIds.length > 0) select(rootDir, navIds[0]);
  }, [selectedId, navIds, select, rootDir]);

  // ── Status routing ──────────────────────────────────────────────────────

  const shell = (children: React.ReactNode) => (
    <div
      data-ctx-surface="knowledge"
      data-ctx-root={rootDir}
      data-ctx-gitignored={project?.gitignored ? "1" : "0"}
      data-ctx-status={rootDir ? status : "remote-unsupported"}
      style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      {children}
    </div>
  );

  // An SSH tab with no usable local twin. Everything below this line assumes a
  // local path, so the link panel has to come before all of it — including the
  // Jira gate, which would otherwise probe a path on the wrong machine.
  if (!rootDir) {
    return shell(
      <KnowledgeRemotePanel
        tabDir={tabDir}
        serverId={serverId}
        proposedPath={
          staleLink ? linkedPath : mirror.kind === "proposed" ? mirror.path : undefined
        }
        stale={staleLink}
        onRelinked={() => setStaleLink(false)}
      />,
    );
  }

  // The Jira gate sits before every other panel: until the probe answers,
  // showing "not offered" would flash a wrong claim at an initialized repo,
  // so the probing state borrows the quiet loading line.
  if (isJiraProject && jiraHasMemory !== true) {
    if (jiraHasMemory === null) {
      return shell(
        <div
          style={{
            padding: 12,
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            color: "var(--ezy-text-muted)",
          }}
        >
          <LoadingDots>Opening knowledge</LoadingDots>
        </div>,
      );
    }
    return shell(<KnowledgeJiraPanel />);
  }

  if (status === "loading") {
    return shell(
      <div
        style={{
          padding: 12,
          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
          color: "var(--ezy-text-muted)",
        }}
      >
        <LoadingDots>Opening knowledge</LoadingDots>
      </div>,
    );
  }

  if (status === "unavailable" || !project) {
    return shell(
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <div
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            color: "var(--ezy-text)",
          }}
        >
          Knowledge is unavailable for this project.
        </div>
        {project?.lastError && (
          <div
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
              color: "var(--ezy-text-muted)",
              lineHeight: 1.4,
              wordBreak: "break-word",
            }}
          >
            {project.lastError}
          </div>
        )}
        <span
          role="button"
          onClick={() => retry(rootDir)}
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-accent)",
            cursor: "pointer",
            alignSelf: "flex-start",
          }}
        >
          Retry
        </span>
      </div>,
    );
  }

  if (status === "uninitialized") {
    return shell(
      <KnowledgeInitPanel
        projectPath={rootDir}
        dismissed={dismissed}
        autoAttach={autoAttach}
        onInitialize={doInitialize}
        onConnect={() => ensureOpen(rootDir)}
        onDismiss={() => dismissInit(key)}
      />,
    );
  }

  const agentReason = "reason" in liveAgentTarget ? liveAgentTarget.reason : null;

  return shell(
    <>
      <KnowledgeSearchBox
        value={project.searchQuery}
        onChange={(v) => setSearchQuery(rootDir, v)}
        onEnterList={focusList}
        busy={project.searching}
        disabled={false}
      />

      {status === "readonly" && <KnowledgeReadonlyBanner reason={project.readonlyReason} />}

      <div
        ref={listRef}
        role="listbox"
        tabIndex={0}
        aria-label="Project knowledge"
        aria-activedescendant={selectedId ? `knowledge-row-${selectedId}` : undefined}
        onKeyDown={handleListKeyDown}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", outline: "none" }}
      >
        {searchResults ? (
          searchResults.length === 0 ? (
            <KnowledgeEmptyLine text={project.searching ? <LoadingDots>Searching</LoadingDots> : "No matches"} />
          ) : (
            searchResults.map((r) => (
              <KnowledgeSearchRow
                key={r.entityId}
                result={r}
                selected={selectedId === r.entityId}
                onSelect={(id) => select(rootDir, id)}
                onOpen={(id) => openNote(id)}
                query={project.searchQuery}
              />
            ))
          )
        ) : (
          <>
            <KnowledgeCoreSection
              notes={notes}
              selectedId={selectedId}
              conflictedIds={conflictedIds}
              onSelect={(id) => select(rootDir, id)}
              onOpen={(id) => openNote(id)}
            />
            <KnowledgeNotesTree
              notes={freeNotes}
              selectedId={selectedId}
              conflictedIds={conflictedIds}
              onSelect={(id) => select(rootDir, id)}
              onOpen={(id) => openNote(id)}
              onNewNote={newNote}
              newNoteBlocked={blocked}
            />
          </>
        )}
      </div>

      {actionError && (
        <div
          style={{
            padding: "6px 10px",
            borderTop: "1px solid var(--ezy-border-subtle)",
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-red)",
            lineHeight: 1.4,
            wordBreak: "break-word",
            flexShrink: 0,
          }}
        >
          {actionError}
        </div>
      )}

      <KnowledgeNoteInfo
        detail={project.noteDetail}
        loadingId={selectedId}
        onSelect={(id) => select(rootDir, id)}
        onHistory={() => selectedId && openHistoryModal(rootDir, selectedId)}
        onInsert={() => selectedId && insertIntoAgent(selectedId)}
        insertBlocked={blocked ?? agentReason}
      />

      <KnowledgeHandoffActions
        workingDir={rootDir}
        onCreateHandoff={createHandoff}
        onContinueHandoff={continueHandoff}
        createBlocked={blocked}
        continueBlocked={blocked ?? agentReason}
        busy={busy}
      />

      <KnowledgeAgentAccess rootDir={rootDir} sequential={freshInit} />

      <KnowledgeFooter
        conflictCount={project.conflictCount}
        pendingApprovals={project.pendingApprovals}
        presence={project.presence}
        onResolveConflicts={() => openConflictModal(rootDir)}
      />
    </>,
  );
}

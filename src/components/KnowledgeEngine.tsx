import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import { useKnowledgeStore } from "../store/knowledgeStore";
import * as api from "../lib/knowledge/api";
import { applyKnowledgeWorld, canonicalProjectKey } from "../lib/knowledge/keys";
import { applyKnowledgeMcpServerName } from "../lib/knowledge/mcp";
import type { KnowledgeChangedPayload } from "../lib/knowledge/types";

/**
 * Jira tabs attach only when the repo already has knowledge, and the probe's
 * answer cannot change behind MADE's back in a way that matters here: a repo
 * initialized later is initialized THROUGH this app, which attaches it as part
 * of doing so. Caching per project key keeps tab switches from re-statting the
 * disk. Failed probes are deliberately not cached — the next activation asks
 * again.
 */
const jiraProbeCache = new Map<string, boolean>();
async function jiraTabHasKnowledge(projectPath: string): Promise<boolean> {
  const key = canonicalProjectKey(projectPath);
  const hit = jiraProbeCache.get(key);
  if (hit !== undefined) return hit;
  const r = await api.readProjectStatus(projectPath);
  if (!r.ok) return false;
  const initialized = r.status.status !== "uninitialized";
  jiraProbeCache.set(key, initialized);
  return initialized;
}

/**
 * Headless owner of NexusMind's two app-wide concerns: the change event, and
 * attaching a project when its tab comes to the front.
 *
 * Mounted ONCE in App.tsx (the `HibernationEngine` precedent) rather than
 * inside Workspace. That placement is load-bearing: every project tab's
 * Workspace stays mounted behind `display:none`, so a listener registered
 * there would fire once per open tab and N tabs would each schedule the same
 * refresh. One listener, one subscriber, one refresh.
 */
export default function KnowledgeEngine() {
  const applyEvent = useKnowledgeStore((s) => s.applyEvent);
  const ensureOpen = useKnowledgeStore((s) => s.ensureOpen);
  const autoAttach = useAppStore((s) => s.knowledgeAutoAttach);

  // Primitive selectors only: returning the tab object would hand every
  // subscriber a new reference on each store write.
  const workingDir = useAppStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.workingDir ?? "");
  const serverId = useAppStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.serverId);
  const isProjectTab = useAppStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    if (!tab) return false;
    return !(tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab);
  });
  const isJiraTab = useAppStore(
    (s) => !!s.tabs.find((t) => t.id === s.activeTabId)?.isJiraProject,
  );

  // ── Per-build world names (live/dev isolation) ──────────────────────────
  //
  // Debug and release builds spell the memory folder and the MCP server name
  // differently. The frontend ships the release defaults and applies the
  // Rust-served truth once at boot — before any project attaches, so no
  // rendered surface ever shows the wrong world's names.
  useEffect(() => {
    void invoke("knowledge_world")
      .then((w) => {
        const world = (w ?? {}) as { memoryDirName?: unknown; mcpServerName?: unknown };
        applyKnowledgeWorld(world);
        applyKnowledgeMcpServerName(world.mcpServerName);
      })
      .catch(() => {}); // release defaults stand; only a debug build differs
    // The user's UTC offset, minutes east (JS reports minutes WEST, hence the
    // sign flip). Rust cannot know the timezone on its own, and frontmatter
    // timestamps in UTC read as "hours behind my clock".
    void invoke("knowledge_set_timezone", {
      offsetMinutes: -new Date().getTimezoneOffset(),
    }).catch(() => {});
  }, []);

  // ── Startup sweep ────────────────────────────────────────────────────────
  //
  // Attach every restored project that ALREADY HAS knowledge, shortly after
  // boot. Two things depend on it: offline edits (made while MADE was closed)
  // reconcile immediately instead of when each tab is next visited, and an
  // agent in a restored pane can reach its project's memory without the user
  // touching that tab first — the adapter can only bind to OPEN projects.
  //
  // "Activation, not startup" was the original rule so projects the user may
  // never look at cost nothing; the read-only probe keeps that property (a
  // never-initialized project costs one stat), and attaches are staggered so
  // boot doesn't shoulder every reconcile walk at once. The probe gate also
  // covers Jira tabs by construction: initialized repos attach, uninitialized
  // ones are never offered anything.
  useEffect(() => {
    if (!autoAttach) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const s = useAppStore.getState();
        const seen = new Set<string>();
        for (const tab of s.tabs) {
          if (cancelled) return;
          if (!tab.workingDir || tab.serverId) continue;
          if (tab.isDevServerTab || tab.isServersTab || tab.isKanbanTab || tab.isSettingsTab) {
            continue;
          }
          const key = canonicalProjectKey(tab.workingDir);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const initialized = await api.probeInitialized(tab.workingDir).catch(() => false);
          if (cancelled) return;
          if (initialized) {
            ensureOpen(tab.workingDir);
            // One reconcile walk at a time — boot has enough to do.
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
      })();
    }, 4000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Boot-time sweep, deliberately not re-run as tabs come and go —
    // activation handles everything after startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAttach, ensureOpen]);

  // ── The single made:knowledge-changed subscription ──────────────────────
  useEffect(() => {
    let un: UnlistenFn | undefined;
    // React 19 StrictMode runs mount/unmount/mount in dev. `listen` resolves a
    // frame later, so the throwaway mount's cleanup runs BEFORE its handle
    // exists — without this flag that handle leaks and the second mount ends
    // up with two live listeners, doubling every refresh.
    let disposed = false;

    void listen<KnowledgeChangedPayload>("made:knowledge-changed", (event) => {
      if (disposed) return;
      const payload = event.payload;
      if (!payload || typeof payload.projectKey !== "string") return;
      applyEvent(payload);
    }).then((handle) => {
      if (disposed) handle();
      else un = handle;
    });

    return () => {
      disposed = true;
      un?.();
    };
  }, [applyEvent]);

  // ── Attach the active project ───────────────────────────────────────────
  //
  // Activation, not startup: opening a database and a filesystem watcher for
  // every restored tab would cost real work for projects the user may never
  // look at. A project stays attached once activated — tab switches are cheap
  // and the undo-close window makes eager detaching wrong.
  useEffect(() => {
    if (!isProjectTab || !workingDir) return;
    // Remote tabs still get an entry so the sidebar can explain itself, and
    // `ensureOpen` invokes nothing for them.
    if (serverId) {
      ensureOpen(workingDir, serverId);
      return;
    }
    if (!autoAttach) return;
    if (isJiraTab) {
      // No offer on Jira tabs: attach only a repo that already has knowledge.
      let cancelled = false;
      void jiraTabHasKnowledge(workingDir).then((has) => {
        if (!cancelled && has) ensureOpen(workingDir);
      });
      return () => {
        cancelled = true;
      };
    }
    ensureOpen(workingDir);
  }, [ensureOpen, workingDir, serverId, isProjectTab, isJiraTab, autoAttach]);

  return null;
}

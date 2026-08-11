import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "../store";
import type { RemoteServer, TerminalType } from "../types";
import {
  isQuickOpenEnabled,
  type RecentProject,
} from "../store/recentProjectsSlice";
import { useOverlayPopupAnchor } from "../native-term/useOverlayPopupAnchor";
import { isWindows, detectBackendForPath } from "../lib/platform";
import {
  cloneLayoutWithFreshIds,
  countLeafPanes,
  buildLayoutFromTemplate,
  stampTerminalTypes,
} from "../lib/layout-utils";
import { spawnDevServer } from "../lib/spawn-dev-server";
import { createJiraProjectAt, createKeyedJiraProject } from "../lib/jira-project";
import { defaultJiraSiteIn } from "../lib/jira-sites";
import { isJiraVirtualDir, jiraVirtualDirLabel } from "../lib/jira-virtual-dir";
import RemoteFileBrowser from "../components/RemoteFileBrowser";
import CreateProjectModal from "../components/CreateProjectModal";
import JiraProjectModal from "../components/JiraProjectModal";

/**
 * The "+" launcher: the recent-projects dropdown and the three modals it opens.
 *
 * Lifted out of TabBar so BOTH tab bars raise the identical menu. Only one bar
 * is mounted at a time (App renders either `<TabBar />` or a vertical strip),
 * so the single-owner things in here — the overlay popup id, the
 * `made:open-recent` listener — stay single-owner.
 *
 * Hover is NOT owned here. TabBar drives hover from a global pointermove
 * hit-test across two buttons (see the long comment at its call site for why
 * enter/leave edges cannot work), and the vertical strip has its own simpler
 * rule; both just pass their handlers in.
 */

/** Truncate a path for the menu's dim second line. */
function truncatePath(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 3) return fullPath;
  return ".../" + parts.slice(-2).join("/");
}

/** Reopen a Jira recent as a Jira tab. Keyed projects (site + project key,
 *  virtual path) route through the keyed creator, which focuses an already-open
 *  tab instead of duplicating it; legacy folder projects reopen exactly as
 *  before. Never the template picker or layout restore — those would rebuild
 *  Jira tabs as plain grids. */
function reopenJiraRecent(project: RecentProject): void {
  if (project.jiraProjectKey) {
    createKeyedJiraProject({
      siteId: project.jiraSiteId || defaultJiraSiteIn(useAppStore.getState()),
      projectKey: project.jiraProjectKey,
    });
  } else {
    void createJiraProjectAt({
      path: project.path,
      serverId: project.serverId,
      siteId: project.jiraSiteId,
    });
  }
}

export interface UseTabLaunchMenuOptions {
  /** Tell the overlay to report pointer enter/leave over the dropdown. */
  hoverTracking: boolean;
  /** Pointer entered the dropdown — cancel any pending hover-close. */
  onHoverIn?: () => void;
  /** Pointer left the dropdown — start the caller's grace timer. */
  onHoverOut?: () => void;
}

export function useTabLaunchMenu(opts: UseTabLaunchMenuOptions) {
  const { hoverTracking, onHoverIn, onHoverOut } = opts;

  const recentProjects = useAppStore((s) => s.recentProjects);
  const servers = useAppStore((s) => s.servers);
  const projectsDir = useAppStore((s) => s.projectsDir);
  const terminalBackend = useAppStore((s) => s.terminalBackend);
  const setPendingDir = useAppStore((s) => s.setPendingDir);
  const toggleProjectQuickOpen = useAppStore((s) => s.toggleProjectQuickOpen);
  const setProjectBackend = useAppStore((s) => s.setProjectBackend);
  const removeRecentProject = useAppStore((s) => s.removeRecentProject);
  const addTerminals = useAppStore((s) => s.addTerminals);
  const addTabWithLayout = useAppStore((s) => s.addTabWithLayout);
  const addRecentProject = useAppStore((s) => s.addRecentProject);
  const autoStartServerCommand = useAppStore((s) => s.autoStartServerCommand);

  const recentBtnRef = useRef<HTMLDivElement>(null);
  const [showRecentMenu, setShowRecentMenu] = useState(false);
  const [browsingServer, setBrowsingServer] = useState<RemoteServer | null>(null);
  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);
  const [showJiraProjectModal, setShowJiraProjectModal] = useState(false);

  // The menu used to be gated on "is there anything to list" —
  // `recentProjects.length || projectsDir || servers.length`. That predated the
  // menu's contents: it has since grown a Create section (New Project, New Jira
  // Project) and an Open section (Browse) that depend on none of those three.
  // On a FRESH INSTALL all three were false, so "+" fell straight through to
  // the folder picker and "New Jira Project…" — which lives only in this menu —
  // was unreachable until a non-Jira project already existed. No gate now: the
  // menu always has actionable rows, so "+" always raises it.

  /** Anchor override: the startup screen's button raises this same menu, and it
   *  must open at the button the user actually clicked rather than at the tab
   *  bar's "+" across the window. Null anchors back to the "+". */
  const splashAnchorRef = useRef<HTMLElement | null>(null);
  const [anchorIsSplash, setAnchorIsSplash] = useState(false);

  /** Every caller outside this hook opens the menu at the "+" — reset the
   *  splash override so a stale anchor from an earlier splash click can't
   *  misplace it (all consumers pass a plain boolean, never an updater). */
  const setRecentMenuOpen = useCallback((next: boolean) => {
    setAnchorIsSplash(false);
    setShowRecentMenu(next);
  }, []);

  const handleNewLocalTab = useCallback(() => {
    window.dispatchEvent(new Event("made:new-tab"));
  }, []);

  const handleRemotePathSelected = useCallback(
    (remotePath: string) => {
      if (!browsingServer) return;
      const name = remotePath.split("/").filter(Boolean).pop() || browsingServer.name;
      setBrowsingServer(null);
      setPendingDir({ name, dir: remotePath, serverId: browsingServer.id });
    },
    [browsingServer, setPendingDir],
  );

  /** Quick-open a recent project using its saved layout (or template fallback). */
  const quickOpenProject = useCallback(
    (project: RecentProject, startFresh: boolean) => {
      if (project.lastLayout) {
        // Last-closed layout — clone with fresh IDs, optionally strip resume IDs
        const { layout, terminalIds } = cloneLayoutWithFreshIds(project.lastLayout, {
          stripResume: startFresh,
        });
        const batch = terminalIds.map((t) => ({
          id: t.id,
          type: t.type,
          workingDir: project.path,
          serverId: project.serverId,
        }));
        addTerminals(batch);
        const tabId = addTabWithLayout(project.name, project.path, layout, project.serverId);
        addRecentProject({
          path: project.path,
          name: project.name,
          template: project.lastTemplate,
          serverId: project.serverId,
        });
        if (project.serverCommand && autoStartServerCommand && !project.noDevServer) {
          spawnDevServer(tabId, project.name, project.path, project.serverCommand, project.serverId);
        }
      } else if (project.lastTemplate) {
        // Fallback to template-based rebuild
        const { templateId, cols, rows, slotTypes, paneCount } = project.lastTemplate;
        const { layout, terminalIds } = buildLayoutFromTemplate(templateId, cols, rows, paneCount);
        const typedLayout = stampTerminalTypes(layout, terminalIds, slotTypes);
        const batch = terminalIds.map((id: string, i: number) => ({
          id,
          type: slotTypes[i] ?? ("shell" as TerminalType),
          workingDir: project.path,
          serverId: project.serverId,
        }));
        addTerminals(batch);
        const tabId = addTabWithLayout(project.name, project.path, typedLayout, project.serverId);
        addRecentProject({
          path: project.path,
          name: project.name,
          template: project.lastTemplate,
          serverId: project.serverId,
        });
        if (project.serverCommand && autoStartServerCommand && !project.noDevServer) {
          spawnDevServer(tabId, project.name, project.path, project.serverCommand, project.serverId);
        }
      }
    },
    [addTerminals, addTabWithLayout, addRecentProject, autoStartServerCommand],
  );

  // Recent-projects dropdown — overlay-rendered (custom kind "recent-menu",
  // backdrop). Live payload: rows update in place (quick/backend/remove keep
  // the menu open, mirroring the old DOM menu).
  useOverlayPopupAnchor({
    id: "tabbar-recent-menu",
    kind: "recent-menu",
    open: showRecentMenu,
    anchorRef: anchorIsSplash ? splashAnchorRef : recentBtnRef,
    payload: showRecentMenu
      ? {
          projects: recentProjects.map((project) => {
            const hasSavedLayout = !!project.lastLayout || !!project.lastTemplate;
            const canQuickOpen = hasSavedLayout && isQuickOpenEnabled(project);
            const savedPaneCount = project.lastLayout
              ? countLeafPanes(project.lastLayout)
              : project.lastTemplate?.paneCount;
            const linkedServer = project.serverId
              ? servers.find((sv) => sv.id === project.serverId)
              : undefined;
            const isOrphanRemote = !!project.serverId && !linkedServer;
            const backend = (() => {
              if (!isWindows() || project.serverId) return null;
              const effective =
                project.preferredBackend ??
                detectBackendForPath(project.path, terminalBackend);
              if (effective !== "wsl" && effective !== "windows") return null;
              return effective === "wsl" ? "WSL" : "WIN";
            })();
            // Keyed Jira rows show the site-host/KEY identity, not a
            // truncated raw "jira://…" string.
            const displayPath = isJiraVirtualDir(project.path)
              ? jiraVirtualDirLabel(project.path)
              : truncatePath(project.path);
            return {
              key: project.id,
              name: project.name,
              subtitle: displayPath,
              tooltip: isOrphanRemote
                ? `Server removed — re-add it in the Remote Servers panel to use this project. (${project.path})`
                : linkedServer
                  ? `${linkedServer.name}: ${project.path}`
                  : jiraVirtualDirLabel(project.path),
              disabled: isOrphanRemote,
              badge: project.serverId
                ? isOrphanRemote
                  ? "no server"
                  : (linkedServer?.name ?? linkedServer?.host ?? "remote")
                : undefined,
              badgeMuted: isOrphanRemote,
              jira: !!project.isJira,
              // Jira projects reopen through their own path (ticket list +
              // per-ticket canvas) — the layout-restore shortcuts would rebuild
              // them as plain grids, so hide those controls for them.
              showFresh: !project.isJira && canQuickOpen,
              showQuick: !project.isJira && hasSavedLayout,
              quickOn: isQuickOpenEnabled(project),
              paneCount: String(savedPaneCount ?? "?"),
              backendLabel: backend ?? undefined,
            };
          }),
          // The modal itself offers local + server locations, so creating is
          // possible as soon as EITHER exists.
          canCreate: !!projectsDir || servers.length > 0,
          servers: servers.map((sv) => ({ id: sv.id, name: sv.name })),
          hoverTracking,
        }
      : null,
    onAction: (action) => {
      if (action === "__hoverin__") {
        onHoverIn?.();
        return;
      }
      if (action === "__hoverout__") {
        onHoverOut?.();
        return;
      }
      if (action === "__dismiss__") {
        setShowRecentMenu(false);
        return;
      }
      const idx = action.indexOf(":");
      const verb = idx === -1 ? action : action.slice(0, idx);
      const arg = idx === -1 ? "" : action.slice(idx + 1);
      const project = recentProjects.find((pr) => pr.id === arg);
      switch (verb) {
        case "open":
          if (!project) return;
          setShowRecentMenu(false);
          // Jira projects reopen as Jira tabs — never through the template
          // picker or layout restore, which would recreate them as plain grids.
          if (project.isJira) {
            reopenJiraRecent(project);
            break;
          }
          if ((!!project.lastLayout || !!project.lastTemplate) && isQuickOpenEnabled(project)) {
            quickOpenProject(project, false);
          } else {
            setPendingDir({
              name: project.name,
              dir: project.path,
              serverId: project.serverId,
            });
          }
          break;
        case "fresh":
          if (!project) return;
          setShowRecentMenu(false);
          quickOpenProject(project, true);
          break;
        case "quick":
          if (project) toggleProjectQuickOpen(project.path, project.serverId);
          break;
        case "backend": {
          if (!project) return;
          const effective =
            project.preferredBackend ??
            detectBackendForPath(project.path, terminalBackend);
          setProjectBackend(
            project.path,
            project.serverId,
            effective === "wsl" ? "windows" : "wsl",
          );
          break;
        }
        case "remove":
          if (project) removeRecentProject(project.path, project.serverId);
          break;
        case "create":
          setShowRecentMenu(false);
          setShowCreateProjectModal(true);
          break;
        case "browse":
          setShowRecentMenu(false);
          handleNewLocalTab();
          break;
        case "jira":
          setShowRecentMenu(false);
          setShowJiraProjectModal(true);
          break;
        case "server": {
          const server = servers.find((sv) => sv.id === arg);
          if (server) {
            setShowRecentMenu(false);
            setBrowsingServer(server);
          }
          break;
        }
      }
    },
  });

  // Open-recent from the startup screen.
  useEffect(() => {
    const handler = (e: Event) => {
      const { path, name } = (e as CustomEvent).detail;
      const project = recentProjects.find((p) => p.path === path);
      // Same Jira routing as the dropdown's "open" — without it a Jira recent
      // clicked on the splash fell into the template-picker path and came back
      // as a plain grid (keyed ones would have folder-picked a jira:// path).
      if (project?.isJira) {
        reopenJiraRecent(project);
        return;
      }
      if (project && (project.lastLayout || project.lastTemplate)) {
        quickOpenProject(project, false);
      } else {
        setPendingDir({ name, dir: path });
      }
    };
    window.addEventListener("made:open-recent", handler);
    return () => window.removeEventListener("made:open-recent", handler);
  }, [recentProjects, quickOpenProject, setPendingDir]);

  /** Click handler for the "+" button: always the menu. The folder picker is
   *  still one click away inside it, under Open → "Browse folder…". */
  const handlePlusClick = useCallback(() => {
    setAnchorIsSplash(false);
    setShowRecentMenu((v) => !v);
  }, []);

  // The startup screen's button raises this menu too (there is no "+" to find
  // before the first tab exists). It passes its own element as the anchor so the
  // menu opens under the button that was clicked. Listener lives here, in the
  // single mounted tab bar, so it exists in every bar mode — horizontal, v1
  // strip and v2 strip all mount this hook.
  useEffect(() => {
    const handler = (e: Event) => {
      const anchor = (e as CustomEvent).detail?.anchor as HTMLElement | undefined;
      splashAnchorRef.current = anchor ?? null;
      setAnchorIsSplash(!!anchor);
      setShowRecentMenu((v) => !v);
    };
    window.addEventListener("made:open-launch-menu", handler);
    return () => window.removeEventListener("made:open-launch-menu", handler);
  }, []);

  const launchModals: ReactNode = (
    <>
      {browsingServer && (
        <RemoteFileBrowser
          server={browsingServer}
          onSelect={handleRemotePathSelected}
          onClose={() => setBrowsingServer(null)}
        />
      )}
      {showCreateProjectModal && (
        <CreateProjectModal
          onCreated={(name, dir, serverId) => {
            setShowCreateProjectModal(false);
            setPendingDir({ name, dir, serverId });
          }}
          onClose={() => setShowCreateProjectModal(false)}
        />
      )}
      {showJiraProjectModal && (
        <JiraProjectModal onClose={() => setShowJiraProjectModal(false)} />
      )}
    </>
  );

  return {
    recentBtnRef,
    showRecentMenu,
    setShowRecentMenu: setRecentMenuOpen,
    handlePlusClick,
    quickOpenProject,
    launchModals,
  };
}

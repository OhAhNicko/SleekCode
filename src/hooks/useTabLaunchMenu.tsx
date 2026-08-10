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
import { createJiraProjectAt } from "../lib/jira-project";
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

  /** Same gate the "+" button's own click handler uses: with nothing to list,
   *  the button is a plain "new tab" action and must not sprout a menu. */
  const canOpenRecent =
    recentProjects.length > 0 || !!projectsDir || servers.length > 0;

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
    anchorRef: recentBtnRef,
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
            return {
              key: project.id,
              name: project.name,
              subtitle: truncatePath(project.path),
              tooltip: isOrphanRemote
                ? `Server removed — re-add it in the Remote Servers panel to use this project. (${project.path})`
                : linkedServer
                  ? `${linkedServer.name}: ${project.path}`
                  : project.path,
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
            void createJiraProjectAt({
              path: project.path,
              serverId: project.serverId,
              siteId: project.jiraSiteId,
            });
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
      if (project && (project.lastLayout || project.lastTemplate)) {
        quickOpenProject(project, false);
      } else {
        setPendingDir({ name, dir: path });
      }
    };
    window.addEventListener("made:open-recent", handler);
    return () => window.removeEventListener("made:open-recent", handler);
  }, [recentProjects, quickOpenProject, setPendingDir]);

  /** Click handler for the "+" button: menu when there is something to list,
   *  otherwise straight to a new tab. */
  const handlePlusClick = useCallback(() => {
    if (canOpenRecent) setShowRecentMenu((v) => !v);
    else handleNewLocalTab();
  }, [canOpenRecent, handleNewLocalTab]);

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
    setShowRecentMenu,
    canOpenRecent,
    handlePlusClick,
    quickOpenProject,
    launchModals,
  };
}

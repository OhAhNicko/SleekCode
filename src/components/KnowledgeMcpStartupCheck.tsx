import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { useKnowledgeStore } from "../store/knowledgeStore";
import { canonicalProjectKey } from "../lib/knowledge/keys";
import { getDefaultBackend } from "../lib/platform";
import { cliStatus } from "../lib/cli-availability";
import { wslReady } from "../lib/wsl-cache";
import { useOverlayToast } from "../lib/useOverlayToast";
import { requestSettingsSection } from "../lib/settings-section";
import { KNOWLEDGE_CLI_LABEL, type KnowledgeCli } from "../lib/knowledge/types";
import { KNOWLEDGE_MCP_SERVER_NAME, readKnowledgeMcpStatus } from "../lib/knowledge/mcp";

/**
 * Startup check: can the agents actually reach this project's memory?
 *
 * NexusMind works from the UI the moment it is initialized, so nothing visibly
 * breaks without the MCP server — the agents simply never read or write any of
 * it, and the user concludes the shared memory does not work. That gap is
 * invisible from inside a pane, which is why it is worth one check at launch.
 *
 * Deliberately quiet. It stays silent unless ALL of these hold:
 *
 *  - the active project has knowledge initialized (nagging about a feature
 *    nobody has turned on is just noise);
 *  - the CLI is actually installed on the machine its panes would run on;
 *  - its config was READ successfully and says the server is absent — an
 *    unreadable config (`checked:false`) says nothing, and telling someone to
 *    install what they already have is worse than staying silent.
 *
 * The read is scoped to the ACTIVE PROJECT, exactly as the Settings row is.
 * MADE registers at user scope, but a user who ran `mcp add` themselves may
 * well have landed at project scope — Gemini's own default — and a user-scope
 * read cannot see that. Omitting the path nagged those users at every launch to
 * install a server they already had, while Settings two clicks away said
 * "Connected (project)".
 */

/** How long to wait for the active project's knowledge to finish attaching. */
const ATTACH_WAIT_MS = 15_000;
const ATTACH_POLL_MS = 500;

/** Wait until the active project's knowledge is attached, or give up quietly. */
async function knowledgeReadyProject(): Promise<string | null> {
  const deadline = Date.now() + ATTACH_WAIT_MS;
  for (;;) {
    const app = useAppStore.getState();
    const tab = app.tabs.find((t) => t.id === app.activeTabId);
    // A remote project has no local knowledge and never will — stop, don't wait.
    if (!tab?.workingDir || tab.serverId) return null;
    const entry = useKnowledgeStore.getState().projects[canonicalProjectKey(tab.workingDir)];
    if (entry?.status === "ready" || entry?.status === "readonly") return tab.workingDir;
    // Uninitialized is a settled answer, not a slow one.
    if (entry && entry.status !== "loading") return null;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, ATTACH_POLL_MS));
  }
}

/**
 * Memoised outside React: StrictMode double-mounts this in dev, and the check
 * reads three CLI configs. Running it twice would double that for nothing.
 */
let checkPromise: Promise<KnowledgeCli[] | null> | null = null;

function runCheck(): Promise<KnowledgeCli[] | null> {
  checkPromise ??= (async () => {
    // Let first paint and the tab/dev-server restore finish first.
    await new Promise((r) => setTimeout(r, 2_000));

    const backend = useAppStore.getState().terminalBackend ?? getDefaultBackend();
    // A WSL read crosses the \\wsl.localhost bridge, which BOOTS the VM when it
    // is cold. resolveWslCliPaths() already pays that cost at startup, so ride
    // its completion instead of racing it.
    if (backend === "wsl") {
      await Promise.race([wslReady, new Promise((r) => setTimeout(r, 20_000))]);
    }

    const projectPath = await knowledgeReadyProject();
    if (!projectPath) return null;

    const results = await Promise.all(
      (["claude", "codex", "gemini"] as const).map(async (cli) => ({
        cli,
        installed: (await cliStatus(cli, backend)) === "present",
        status: await readKnowledgeMcpStatus(cli, backend, projectPath),
      })),
    );
    return results
      .filter((r) => r.installed && r.status.checked && !r.status.configured)
      .map((r) => r.cli);
  })();
  return checkPromise;
}

export default function KnowledgeMcpStartupCheck() {
  const [missing, setMissing] = useState<KnowledgeCli[]>([]);

  useEffect(() => {
    let alive = true;
    void runCheck().then((result) => {
      if (alive && result?.length) setMissing(result);
    });
    return () => {
      alive = false;
    };
  }, []);

  const show = missing.length > 0;

  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => setMissing([]), 15_000);
    return () => clearTimeout(t);
  }, [show]);

  useOverlayToast({
    id: "knowledge-mcp-startup",
    open: show,
    payload: show
      ? {
          placement: "bottom-right",
          variant: "surface",
          // The surface toast keeps its title on ONE line and shows `detail`
          // only as a tooltip, so the names go in the title — short forms,
          // because all three at full length would ellipsize.
          title: `NexusMind not connected: ${missing.map((c) => KNOWLEDGE_CLI_LABEL[c]).join(", ")}`,
          detail: `These CLIs can't read or write this project's memory until the ${KNOWLEDGE_MCP_SERVER_NAME} MCP server is added.`,
          button: { label: "Open settings", action: "settings" },
          dismissable: true,
        }
      : null,
    onAction: (action) => {
      setMissing([]);
      if (action !== "settings") return;
      if (!useAppStore.getState().settingsPanelOpen) {
        useAppStore.setState({ sidebarOpen: false, devServerPanelOpen: false });
        useAppStore.getState().setSettingsPanelOpen(true);
      }
      requestSettingsSection("nexusmind");
    },
  });

  return null;
}

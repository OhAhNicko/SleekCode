import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { getDefaultBackend } from "../lib/platform";
import {
  readJiraMcpStatus,
  JIRA_CLIS,
  JIRA_CLI_LABEL,
  type JiraCli,
} from "../lib/jira-mcp";
import { wslReady } from "../lib/wsl-cache";
import { useOverlayToast } from "../lib/useOverlayToast";
import { requestSettingsSection } from "../lib/settings-section";

/**
 * Startup check: is the Atlassian MCP server configured?
 *
 * Without it a Jira ticket pane spawns fine and then reports it cannot reach
 * Jira, which reads as "the feature is broken". Finding that out at launch —
 * rather than three clicks into a ticket — is the whole point.
 *
 * Deliberately quiet: it names ONLY CLIs that definitely lack the server. A
 * failed lookup (`checked: false`) says nothing, because telling someone to
 * install what they already have is worse than staying silent — and that same
 * state is what a CLI you don't have installed produces, so an unused CLI never
 * nags either.
 *
 * Cost: one config read per CLI. It is scheduled off the boot path (see
 * `runCheck`), so it never competes with pane spawns.
 */

/** "codex" → "Codex". The toast has one line for every name it prints. */
const shortLabel = (cli: JiraCli): string => cli[0].toUpperCase() + cli.slice(1);

/** User-scope config only — no project path, so this is one read per CLI. */
let checkPromise: Promise<JiraCli[] | null> | null = null;

function runCheck(): Promise<JiraCli[] | null> {
  checkPromise ??= (async () => {
    // Jira mode off → the feature is hidden, so don't nag about its plugin.
    if (!(useAppStore.getState().jiraMode ?? true)) return null;

    // Let first paint and the tab/dev-server restore finish first.
    await new Promise((r) => setTimeout(r, 2_000));

    const backend = useAppStore.getState().terminalBackend ?? getDefaultBackend();
    // A WSL read crosses the \\wsl.localhost 9P bridge, which BOOTS the VM when
    // it is cold. resolveWslCliPaths() already pays exactly that cost at
    // startup, so ride its completion instead of racing it. wslReady resolves
    // on failure too; the timeout only covers it never settling at all.
    if (backend === "wsl") {
      await Promise.race([wslReady, new Promise((r) => setTimeout(r, 20_000))]);
    }

    const results = await Promise.all(
      JIRA_CLIS.map(async (cli) => ({ cli, status: await readJiraMcpStatus(cli, backend) })),
    );
    return results.filter((r) => r.status.checked && !r.status.configured).map((r) => r.cli);
  })();
  return checkPromise;
}

export default function JiraMcpStartupCheck() {
  const [missing, setMissing] = useState<JiraCli[]>([]);

  // The check itself lives outside React and is memoised, so StrictMode's
  // double-mount awaits the same promise instead of reading every config twice.
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
    id: "jira-mcp-startup",
    open: show,
    payload: show
      ? {
          placement: "bottom-right",
          variant: "surface",
          // The surface toast keeps its title on ONE line and shows `detail`
          // only as its tooltip, so the names go in the title — short forms,
          // because all three at full length would ellipsize.
          title: `Jira plugin missing: ${missing.map(shortLabel).join(", ")}`,
          detail: `${missing
            .map((c) => JIRA_CLI_LABEL[c])
            .join(", ")} cannot reach Atlassian until the MCP server is added.`,
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
      requestSettingsSection("jira");
    },
  });

  return null;
}

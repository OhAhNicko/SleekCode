import { useAppStore } from "../store";
import { generateTerminalId } from "./layout-utils";

export function spawnDevServer(
  tabId: string,
  tabName: string,
  workingDir: string,
  command: string,
): string {
  const store = useAppStore.getState();
  const norm = (p: string) => p.replace(/\\/g, "/");
  const existing = store.devServers.find(
    (ds) => norm(ds.workingDir) === norm(workingDir),
  );
  if (existing) return existing.terminalId;

  const terminalId = generateTerminalId();
  store.addTerminal(terminalId, "devserver", workingDir);
  store.addDevServer({
    id: `ds-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    terminalId,
    tabId,
    projectName: tabName,
    command,
    workingDir,
    port: 0,
    status: "running",
  });
  useAppStore.setState((state) => ({
    tabs: state.tabs.map((t) =>
      t.id === tabId ? { ...t, serverCommand: command } : t,
    ),
  }));
  return terminalId;
}

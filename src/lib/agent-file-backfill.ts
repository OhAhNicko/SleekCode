/**
 * Late-CLI guideline backfill.
 *
 * Guideline files are per-CLI (Claude reads CLAUDE.md, Codex AGENTS.md, Gemini
 * GEMINI.md). A project scaffolded for one CLI leaves the others blind when
 * they arrive later — so when a CLI pane spawns in a project that LACKS its
 * file but HAS another one, offer a one-click pointer file referencing the
 * existing canonical doc. Never writes silently (a surprise file in a repo is
 * a surprise git diff); asks once per project+file per app run; works for
 * local and remote (SSH) projects alike.
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { confirmAction } from "./prompt-modal";
import { pointerStub, remoteJoin } from "./remote-project";
import type { TerminalType } from "../types";

const FILE_FOR_TYPE: Partial<Record<TerminalType, string>> = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  gemini: "GEMINI.md",
};

const CLI_LABEL: Partial<Record<TerminalType, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
};

/** Preferred reference target when several guideline files exist. */
const CANONICAL_ORDER = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];

/** `${serverId}|${dir}|${file}` already offered this app run (asked OR declined). */
const offered = new Set<string>();

/** The PromptModal host handles one request at a time — a second event while
 *  one is open would orphan the first resolver. Serialize all offers. */
let chain: Promise<void> = Promise.resolve();

export function maybeOfferAgentFile(
  type: TerminalType,
  workingDir: string,
  serverId?: string,
): void {
  const wanted = FILE_FOR_TYPE[type];
  if (!wanted || !workingDir) return;
  const key = `${serverId ?? ""}|${workingDir}|${wanted}`;
  if (offered.has(key)) return;
  offered.add(key);
  chain = chain.then(() => offer(type, wanted, workingDir, serverId)).catch(() => {});
}

async function offer(
  type: TerminalType,
  wanted: string,
  workingDir: string,
  serverId?: string,
): Promise<void> {
  const server = serverId
    ? useAppStore.getState().servers.find((s) => s.id === serverId)
    : null;
  if (serverId && !server) return;
  const identityFile =
    server && server.authMethod === "ssh-key" && server.sshKeyPath ? server.sshKeyPath : null;

  let names: string[];
  try {
    if (server) {
      const entries = await invoke<string[]>("ssh_ls", {
        host: server.host,
        username: server.username,
        path: workingDir,
        identityFile,
      });
      names = entries.map((e) => e.replace(/\/$/, "").toLowerCase());
    } else {
      const entries = await invoke<{ name: string }[]>("list_dir", { path: workingDir });
      names = entries.map((e) => e.name.toLowerCase());
    }
  } catch {
    return; // unreadable dir — never block a spawn over this
  }

  if (names.includes(wanted.toLowerCase())) return;
  const canonical = CANONICAL_ORDER.find(
    (c) => c !== wanted && names.includes(c.toLowerCase()),
  );
  if (!canonical) return; // no guidelines at all — nothing to point at

  const label = CLI_LABEL[type] ?? type;
  const ok = await confirmAction({
    title: `Add ${wanted} for ${label}?`,
    detail: `${label} reads ${wanted}, but this project only has ${canonical}. Create ${wanted} as a small pointer file so ${label} follows the same guidelines?`,
    confirmLabel: "Create pointer",
  });
  if (!ok) return;

  const content = pointerStub(wanted, canonical);
  try {
    if (server) {
      await invoke("ssh_write_file", {
        host: server.host,
        username: server.username,
        path: remoteJoin(workingDir, wanted),
        content,
        identityFile,
      });
    } else {
      const sep = workingDir.includes("\\") ? "\\" : "/";
      await invoke("write_file", { path: `${workingDir}${sep}${wanted}`, content });
    }
  } catch {
    // Best-effort — the pane is already running; failing to add a pointer
    // file must never break anything.
  }
}

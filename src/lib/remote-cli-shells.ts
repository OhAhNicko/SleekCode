/**
 * Per-server shell/CLI detection for SSH panes.
 *
 * `ssh host "exec claude"` runs the login shell NON-interactively, so PATH
 * additions from .zshrc/.zprofile never load and the CLI is "command not
 * found" — even though it works when the user SSHes in by hand. The fix is to
 * exec CLIs through an interactive login shell (`zsh -lic 'claude …'`), but
 * WHICH shell differs per server. The Rust `ssh_detect_cli_shells` command
 * probes once (login shell, available shells, per-CLI resolvability under
 * `-lic`); the result is persisted on the RemoteServer so later spawns are
 * instant. Test Connection re-probes, so installing a CLI later just needs a
 * re-test.
 */
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { RemoteServer, RemoteCliShells, TerminalType } from "../types";

const inflight = new Map<string, Promise<RemoteCliShells | null>>();

const SHELL_NAME_RE = /^[a-z0-9_-]+$/;

export function parseCliShellProbe(raw: string): RemoteCliShells {
  const shells: string[] = [];
  const found: { shell: string; cli: string }[] = [];
  let defaultShell: string | undefined;

  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.startsWith("SHELL:")) {
      const base = t.slice("SHELL:".length).split("/").filter(Boolean).pop() ?? "";
      if (SHELL_NAME_RE.test(base)) defaultShell = base;
    } else if (t.startsWith("HAVE:")) {
      const s = t.slice("HAVE:".length);
      if (SHELL_NAME_RE.test(s)) shells.push(s);
    } else if (t.startsWith("CLI:")) {
      const [shell, cli] = t.slice("CLI:".length).split(":");
      if (shell && cli && SHELL_NAME_RE.test(shell)) found.push({ shell, cli });
    }
  }

  // Per CLI, prefer the login shell's env; else the first shell that resolves
  // it (probe order zsh, bash).
  const cli: RemoteCliShells["cli"] = {};
  for (const name of ["claude", "codex", "gemini"] as const) {
    const hits = found.filter((f) => f.cli === name);
    if (hits.length === 0) continue;
    const preferred = hits.find((h) => h.shell === defaultShell) ?? hits[0];
    cli[name] = preferred.shell;
  }

  return { defaultShell, shells, cli, detectedAt: Date.now() };
}

/** One-shot probe without persistence — for callers whose server object has
 *  no id yet (the token wizard runs off unsaved form data). */
export async function probeCliShells(conn: {
  host: string;
  username: string;
  authMethod: string;
  sshKeyPath?: string;
}): Promise<RemoteCliShells | null> {
  if (!(conn.authMethod === "ssh-key" && conn.sshKeyPath)) return null;
  try {
    const raw = await invoke<string>("ssh_detect_cli_shells", {
      host: conn.host,
      username: conn.username,
      identityFile: conn.sshKeyPath,
    });
    return parseCliShellProbe(raw);
  } catch {
    return null;
  }
}

/** Probe now and persist onto the server. Returns null on failure (no key,
 *  unreachable) — callers fall back to the un-wrapped spawn. */
export async function detectRemoteCliShells(server: RemoteServer): Promise<RemoteCliShells | null> {
  const existing = inflight.get(server.id);
  if (existing) return existing;

  const p = (async () => {
    try {
      const info = await probeCliShells(server);
      if (info) useAppStore.getState().updateServer(server.id, { detectedCliShells: info });
      return info;
    } finally {
      inflight.delete(server.id);
    }
  })();
  inflight.set(server.id, p);
  return p;
}

/** Cached info, probing on first use. */
export async function ensureRemoteCliShells(server: RemoteServer): Promise<RemoteCliShells | null> {
  if (server.detectedCliShells) return server.detectedCliShells;
  return detectRemoteCliShells(server);
}

/** Which shell a pane of `type` should exec through on this server —
 *  undefined keeps the legacy bare `exec <cli>` / `exec bash -l`. */
export function pickExecShell(
  info: RemoteCliShells | null,
  type: TerminalType,
): string | undefined {
  if (!info) return undefined;
  if (type === "claude" || type === "codex" || type === "gemini") return info.cli[type];
  // shell / devserver panes: land the user in their actual login shell.
  return info.defaultShell && SHELL_NAME_RE.test(info.defaultShell) ? info.defaultShell : undefined;
}

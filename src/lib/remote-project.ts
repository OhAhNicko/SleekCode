/**
 * Create a new project directory ON A REMOTE SERVER, including scaffold files
 * (CLAUDE.md / AGENTS.md / …) copied from local templates over SSH.
 *
 * The local twin is the Rust `create_project` command; this mirrors its
 * semantics (pointer stubs, empty file when no template) using the existing
 * `ssh_mkdir` + `ssh_write_file` commands so no new Rust surface is needed.
 * Requires key-auth servers — the underlying ssh commands run non-interactively.
 */
import { invoke } from "@tauri-apps/api/core";
import type { RemoteServer } from "../types";

export interface RemoteScaffoldSpec {
  filename: string;
  /** Local template path; null/"" writes an empty file. */
  source: string | null;
  role: "claude" | "agents" | "gemini" | "custom";
}

/** Mirror of `pointer_stub` in src-tauri/src/lib.rs — keep the wording in sync. */
export function pointerStub(filename: string, canonical = "AGENTS.md"): string {
  return `# ${filename}\n\nThis project uses a single source of truth for AI agent instructions.\n\nSee [${canonical}](./${canonical}) for the canonical instructions.\n`;
}

export function remoteJoin(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export async function createRemoteProject(
  server: RemoteServer,
  projectDir: string,
  scaffolds: RemoteScaffoldSpec[],
  singleSourcePointers: boolean,
): Promise<void> {
  const identityFile =
    server.authMethod === "ssh-key" && server.sshKeyPath ? server.sshKeyPath : null;
  const base = { host: server.host, username: server.username, identityFile };

  await invoke("ssh_mkdir", { ...base, path: projectDir });

  const hasAgentsWithSource = scaffolds.some((s) => s.role === "agents" && !!s.source);

  for (const s of scaffolds) {
    const dest = remoteJoin(projectDir, s.filename);
    const isAgent = s.role === "claude" || s.role === "agents" || s.role === "gemini";

    let content = "";
    if (singleSourcePointers && isAgent && s.role !== "agents" && hasAgentsWithSource) {
      content = pointerStub(s.filename);
    } else if (s.source) {
      content = await invoke<string>("read_file", { path: s.source });
    }
    await invoke("ssh_write_file", { ...base, path: dest, content });
  }
}

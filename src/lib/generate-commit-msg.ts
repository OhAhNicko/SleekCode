import { invoke, Channel } from "@tauri-apps/api/core";
import { getCachedCliPath, getCachedDistro } from "./wsl-cache";
import { useAppStore } from "../store";

// For Claude: meta-prompt + diff combined into one stdin payload
const META_PROMPT = `You are generating a git commit message. Output ONLY the commit message — no preamble, no markdown fences, no explanation.

Format: conventional commit with bullet body.
- Line 1: type(scope): concise summary (max 72 chars). Types: feat, fix, chore, refactor, docs, style, test.
- Line 2: blank
- Lines 3+: bullet list (- prefix) grouping changes by area or feature. Each bullet summarizes a conceptual change — not raw filenames.

Example:
feat: commit popover, multi-lang safety checks

- CommitPopover with safety checks, file staging, secrets scanning
- Multi-language lint/test/typecheck detection in Rust backend
- New "Commit & Push" button with Ctrl+Shift+Enter shortcut

For small changes (1-3 files), a single subject line is sufficient — skip the bullets.

Analyze the diff below and write a commit message. Focus on WHAT changed semantically, not filenames.

Diff:`;

// For Codex: same meta-prompt is combined with diff and passed as exec argument

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][0-9A-B]/g, "")
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, "");
}

function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Spawn a hidden Claude CLI process to generate a commit message from a diff.
 * Follows the same PTY pattern as promptify.ts.
 */
export function generateCommitMsg(diff: string): Promise<string> {
  const shadowCli = useAppStore.getState().shadowAiCli ?? "claude";
  const cliPath = getCachedCliPath(shadowCli);
  const distro = getCachedDistro();

  if (!cliPath) {
    return Promise.reject(new Error(`${shadowCli} CLI path not cached. Open a ${shadowCli} pane first.`));
  }

  // Truncate diff if massive — keep first 12K chars to stay within context
  const truncatedDiff = diff.length > 12000
    ? diff.slice(0, 12000) + "\n\n... (diff truncated)"
    : diff;

  // Both CLIs: encode meta-prompt + diff together
  const fullPrompt = `${META_PROMPT}\n${truncatedDiff}`;
  const b64 = toBase64(fullPrompt);
  const distroArgs = distro ? ["-d", distro] : [];
  const marker = `__EZYDEV_COMMITMSG_${Date.now()}__`;

  return new Promise((resolve, reject) => {
    let output = "";
    let ptyId: number | null = null;
    let settled = false;

    function settle(result: string | Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (idleTimer) clearTimeout(idleTimer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    }

    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    function trySettleFromOutput() {
      let cleaned = stripAnsi(output).trim();
      const mIdx = cleaned.indexOf(marker);
      if (mIdx < 0) return;
      cleaned = cleaned.substring(mIdx + marker.length).trim();
      if (cleaned.length < 5) return;
      if (ptyId !== null) {
        invoke("pty_kill", { ptyId }).catch(() => {});
        ptyId = null;
      }
      settle(cleaned);
    }

    const onDataChan = new Channel<number[]>();
    onDataChan.onmessage = (data) => {
      output += new TextDecoder().decode(new Uint8Array(data));
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(trySettleFromOutput, 3000);
    };

    const onExitChan = new Channel<number>();
    onExitChan.onmessage = () => {
      ptyId = null;
      let cleaned = stripAnsi(output).trim();
      const mIdx = cleaned.indexOf(marker);
      if (mIdx >= 0) {
        cleaned = cleaned.substring(mIdx + marker.length).trim();
      }
      settle(cleaned || "chore: update files");
    };

    // 30s timeout (commit msgs are short, shouldn't need 60s)
    const timeout = setTimeout(() => {
      if (ptyId !== null) {
        invoke("pty_kill", { ptyId }).catch(() => {});
        ptyId = null;
      }
      settle(new Error("Commit message generation timed out"));
    }, 30000);

    // Claude: pipe full prompt to stdin via `claude -p` with TERM=dumb
    // Codex: pipe stdin to `codex exec --color never -` (silent mode)
    const termExport = shadowCli === "codex" ? "export TERM=xterm-256color" : "export TERM=dumb";
    const cliCmd = shadowCli === "codex"
      ? `echo '${b64}' | base64 -d | ${cliPath} exec --skip-git-repo-check --color never - 2>/dev/null`
      : `echo '${b64}' | base64 -d | ${cliPath} -p`;
    const bashCmd = `unset CLAUDECODE; ${termExport}; echo '${marker}'; ${cliCmd}`;

    invoke<number>("pty_spawn", {
      command: "wsl.exe",
      args: [...distroArgs, "--", "bash", "-lic", bashCmd],
      cols: 200,
      rows: 50,
      cwd: null,
      env: { TERM: shadowCli === "codex" ? "xterm-256color" : "dumb" },
      onData: onDataChan,
      onExit: onExitChan,
    })
      .then((id) => { ptyId = id; })
      .catch((e) => settle(e instanceof Error ? e : new Error(String(e))));
  });
}

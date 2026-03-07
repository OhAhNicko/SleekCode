import { invoke, Channel } from "@tauri-apps/api/core";
import { getCachedWslPath, getCachedCliPath, getCachedDistro } from "./wsl-cache";

const META_PROMPT = `Rewrite this short coding instruction into a sharp, actionable prompt for an AI coding assistant (like Claude Code). Output 2-4 concise sentences max. Be specific about what to change and the expected outcome. Mention edge cases only if critical. Say "preserve existing patterns" if relevant. No preamble, no markdown, no meta-commentary — output ONLY the rewritten prompt.

Short instruction:`;

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, "") // CSI sequences (incl. DEC private ?/</> modes)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences
    .replace(/\x1b[()][0-9A-B]/g, "") // charset selection
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, ""); // control chars
}

/** Base64 encode a string (handles Unicode) */
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Spawn a hidden Claude CLI process in print mode to rewrite a short prompt
 * into a detailed agentic coding prompt.
 *
 * We spawn a bare `bash --norc --noprofile` and write commands via pty_write
 * rather than passing a long command as a `-lic` argument — Windows
 * command-line escaping mangles nested quotes in long args passed to wsl.exe.
 */
export function promptify(shortPrompt: string): Promise<string> {
  const cachedPath = getCachedWslPath();
  const cliPath = getCachedCliPath("claude");
  const distro = getCachedDistro();

  console.log("[Promptify] starting", { cachedPath: !!cachedPath, cliPath, distro });

  if (!cachedPath || !cliPath) {
    return Promise.reject(new Error("Claude CLI path not cached. Open a Claude pane first."));
  }

  const fullPrompt = `${META_PROMPT} ${shortPrompt}`;
  const b64 = toBase64(fullPrompt);
  const distroArgs = distro ? ["-d", distro] : [];
  const marker = `__EZYDEV_PROMPTIFY_${Date.now()}__`;

  console.log("[Promptify] b64 length:", b64.length, "marker:", marker);

  return new Promise((resolve, reject) => {
    let output = "";
    let ptyId: number | null = null;
    let settled = false;
    let dataChunks = 0;

    function settle(result: string | Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (idleTimer) clearTimeout(idleTimer);
      console.log("[Promptify] settled:", result instanceof Error ? `ERROR: ${result.message}` : `OK (${result.length} chars)`);
      console.log("[Promptify] total data chunks received:", dataChunks);
      console.log("[Promptify] raw output (first 500):", output.slice(0, 500));
      if (result instanceof Error) reject(result);
      else resolve(result);
    }

    // Idle timer: claude -p outputs the result then hangs (sends terminal
    // queries to the PTY that never get answered). After 3s of silence
    // following meaningful output, extract the result and kill the process.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    function trySettleFromOutput() {
      let cleaned = stripAnsi(output).trim();
      const mIdx = cleaned.indexOf(marker);
      if (mIdx < 0) return; // marker not yet received
      cleaned = cleaned.substring(mIdx + marker.length).trim();
      if (cleaned.length < 20) return; // not enough output yet
      console.log("[Promptify] idle settle — got output after marker:", cleaned.length, "chars");
      if (ptyId !== null) {
        invoke("pty_kill", { ptyId }).catch(() => {});
        ptyId = null;
      }
      settle(cleaned);
    }

    const onDataChan = new Channel<number[]>();
    onDataChan.onmessage = (data) => {
      const chunk = new TextDecoder().decode(new Uint8Array(data));
      output += chunk;
      dataChunks++;
      if (dataChunks <= 5) {
        console.log(`[Promptify] data chunk #${dataChunks} (${chunk.length} bytes):`, JSON.stringify(chunk.slice(0, 200)));
      }
      // Reset idle timer on each chunk
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(trySettleFromOutput, 3000);
    };

    const onExitChan = new Channel<number>();
    onExitChan.onmessage = (code) => {
      console.log("[Promptify] process exited with code:", code);
      ptyId = null;
      let cleaned = stripAnsi(output).trim();
      console.log("[Promptify] cleaned (first 500):", cleaned.slice(0, 500));
      // Strip bash prompt noise — everything before the marker
      const mIdx = cleaned.indexOf(marker);
      console.log("[Promptify] marker index:", mIdx);
      if (mIdx >= 0) {
        cleaned = cleaned.substring(mIdx + marker.length).trim();
      }
      settle(cleaned || "Failed to rewrite prompt");
    };

    // Safety timeout: kill after 60s
    const timeout = setTimeout(() => {
      console.log("[Promptify] TIMEOUT after 60s. Data chunks received:", dataChunks, "Output so far:", output.slice(0, 300));
      if (ptyId !== null) {
        invoke("pty_kill", { ptyId }).catch(() => {});
        ptyId = null;
      }
      settle(new Error("Promptify timed out"));
    }, 60000);

    // Pipe decoded prompt directly to `claude -p` stdin.
    // Avoids ALL problematic chars for Windows/WSL arg passing: no >, <, ", $().
    // bash -lic sources .bashrc (nvm/PATH setup), so no explicit PATH needed.
    // Only single quotes used (safe: b64 is A-Za-z0-9+/=, marker is alphanum).
    const bashCmd = `unset CLAUDECODE; export TERM=dumb; echo '${marker}'; echo '${b64}' | base64 -d | ${cliPath} -p`;

    console.log("[Promptify] spawning PTY, cmd length:", bashCmd.length);
    invoke<number>("pty_spawn", {
      command: "wsl.exe",
      args: [...distroArgs, "--", "bash", "-lic", bashCmd],
      cols: 200,
      rows: 50,
      cwd: null,
      env: { TERM: "dumb" },
      onData: onDataChan,
      onExit: onExitChan,
    })
      .then((id) => {
        ptyId = id;
        console.log("[Promptify] PTY spawned with id:", id);
      })
      .catch((e) => {
        console.error("[Promptify] spawn failed:", e);
        settle(e instanceof Error ? e : new Error(String(e)));
      });
  });
}

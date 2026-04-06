import { invoke, Channel } from "@tauri-apps/api/core";
import { getCachedWslPath, getCachedCliPath, getCachedDistro } from "./wsl-cache";
import { useAppStore } from "../store";
import type { CrosswordPuzzle } from "../types";

const CROSSWORD_PROMPT = `Generate a crossword puzzle grid with tech/programming themed words. The grid should be 7x7. Use '#' for black cells and uppercase letters for white cells.

Output ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "id": "custom-<random-4-digits>",
  "grid": [["A","#","B",...], ...],
  "clues": {
    "across": [{"number":1,"clue":"description","answer":"WORD","row":0,"col":0}, ...],
    "down": [{"number":2,"clue":"description","answer":"WORD","row":0,"col":2}, ...]
  }
}

Requirements:
- Use words like: API, CACHE, DOCKER, KERNEL, REGEX, QUERY, MUTEX, STACK, HEAP, CORS, TOKEN, HASH, ASYNC, AWAIT, PARSE, DEBUG, PROXY, REDIS, NGINX, FLASK, DJANGO, RAILS, REACT, HOOKS, STATE, PROPS, ROUTE, FETCH, PATCH, MERGE, CLONE, REBASE, LINT, BUILD, DEPLOY, CICD, HELM, PODS, NODE, YARN, RUST, WASM, etc.
- row/col are 0-indexed positions of the first letter of each word
- Every letter in the grid must belong to at least one across or down word
- Clues should be informative and fun`;

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

function parseJsonFromOutput(output: string): CrosswordPuzzle | null {
  // Find JSON object in the output
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;

  try {
    const parsed = JSON.parse(output.substring(start, end + 1));
    // Validate structure
    if (!parsed.id || !Array.isArray(parsed.grid) || !parsed.clues) return null;
    if (!Array.isArray(parsed.clues.across) || !Array.isArray(parsed.clues.down)) return null;
    if (parsed.grid.length < 5) return null;
    return parsed as CrosswordPuzzle;
  } catch {
    return null;
  }
}

export function generateCrossword(): Promise<CrosswordPuzzle> {
  const shadowCli = useAppStore.getState().shadowAiCli ?? "claude";
  const cachedPath = getCachedWslPath();
  const cliPath = getCachedCliPath(shadowCli);
  const distro = getCachedDistro();

  if (!cachedPath || !cliPath) {
    return Promise.reject(new Error(`${shadowCli} CLI path not cached. Open a ${shadowCli} pane first.`));
  }

  const b64 = toBase64(CROSSWORD_PROMPT);
  const distroArgs = distro ? ["-d", distro] : [];
  const marker = `__EZYDEV_CROSSWORD_${Date.now()}__`;

  return new Promise((resolve, reject) => {
    let output = "";
    let ptyId: number | null = null;
    let settled = false;

    function settle(result: CrosswordPuzzle | Error) {
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
      if (cleaned.length < 50) return;

      const puzzle = parseJsonFromOutput(cleaned);
      if (puzzle) {
        if (ptyId !== null) {
          invoke("pty_kill", { ptyId }).catch(() => {});
          ptyId = null;
        }
        settle(puzzle);
      }
    }

    const onDataChan = new Channel<number[]>();
    onDataChan.onmessage = (data) => {
      const chunk = new TextDecoder().decode(new Uint8Array(data));
      output += chunk;
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
      const puzzle = parseJsonFromOutput(cleaned);
      if (puzzle) {
        settle(puzzle);
      } else {
        settle(new Error("Failed to generate crossword puzzle — invalid AI output"));
      }
    };

    const timeout = setTimeout(() => {
      if (ptyId !== null) {
        invoke("pty_kill", { ptyId }).catch(() => {});
        ptyId = null;
      }
      settle(new Error("Crossword generation timed out"));
    }, 90000);

    const termExport = shadowCli === "codex" ? "export TERM=xterm-256color" : "export TERM=dumb";
    const cliCmd = shadowCli === "codex"
      ? `echo '${b64}' | base64 -d | ${cliPath} exec --skip-git-repo-check --color never - 2>/dev/null`
      : `echo '${b64}' | base64 -d | ${cliPath} -p`;
    const bashCmd = `cd /tmp; unset CLAUDECODE; ${termExport}; echo '${marker}'; ${cliCmd}`;

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
      .catch((e) => {
        settle(e instanceof Error ? e : new Error(String(e)));
      });
  });
}

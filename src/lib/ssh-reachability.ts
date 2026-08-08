/**
 * Is a remote server actually reachable RIGHT NOW?
 *
 * The CLI-availability answer for SSH panes comes from
 * `server.detectedCliShells` — a probe result persisted the last time the
 * connection worked. With the connection down that answer is stale in the
 * worst way: the pane asserts "Codex isn't installed on Job" and offers an
 * Install that cannot possibly run. This module supplies the missing fact —
 * "can we even talk to that machine?" — so the panes can say "no connection"
 * instead of lying about installs.
 *
 * Two complementary mechanisms:
 *
 * 1. `checkServerReachable` — an active probe (the existing Rust
 *    `ssh_test_connection`, BatchMode + ConnectTimeout=5). Used BEFORE showing
 *    the missing-CLI card. BatchMode means a password-auth server fails the
 *    probe even when it is up, so for those the answer is `null` ("can't
 *    tell"), never `false` — an unprovable server must not be reported
 *    offline.
 *
 * 2. `SshSpawnFailureWatch` — a passive matcher over a remote pane's first
 *    bytes. When ssh dies before ever connecting, the ONLY output is the ssh
 *    client's own error (`ssh: connect to host … Connection timed out`). The
 *    watch recognises exactly those pre-connection failures so the pane can
 *    replace a dead terminal with a "no connection" card. Mid-session drops
 *    (`client_loop:`, `Connection to X closed`) are deliberately NOT matched:
 *    by then the pane holds scrollback the user may still want to read.
 */

import { invoke } from "@tauri-apps/api/core";
import type { RemoteServer } from "../types";

/** UI patience for the probe: ConnectTimeout=5 plus ssh startup slack. */
const PROBE_DEADLINE_MS = 8_000;

/**
 * Breadcrumbs for the spawn-failure path → %TEMP%\made-logs\made-<profile>.log.
 * The path has already failed silently twice (raw-byte matching under ConPTY,
 * then exit/data channel ordering); every fork logs so the NEXT silent miss
 * names its own broken link instead of needing a debugging session.
 */
export function sshWatchLog(msg: string): void {
  void invoke("debug_log_line", { line: `[ssh-watch] ${msg}` }).catch(() => {});
}

const inflight = new Map<string, Promise<boolean | null>>();

/**
 * `true` = server answered, `false` = it did not, `null` = unknowable
 * (password auth — BatchMode can never prove anything about those).
 * Concurrent callers for the same server share one probe; no result is
 * cached, because "reachable" is only ever true of the moment it was asked.
 */
export function checkServerReachable(server: RemoteServer): Promise<boolean | null> {
  if (server.authMethod !== "ssh-key" || !server.sshKeyPath) return Promise.resolve(null);

  const existing = inflight.get(server.id);
  if (existing) return existing;

  const probe = invoke<boolean>("ssh_test_connection", {
    host: server.host,
    username: server.username,
    identityFile: server.sshKeyPath,
  }).catch(() => false);

  // A probe that never settles must degrade to "can't tell", not hang the
  // gate that is waiting on it.
  const p = Promise.race([
    probe,
    new Promise<null>((r) => setTimeout(() => r(null), PROBE_DEADLINE_MS)),
  ]).finally(() => {
    inflight.delete(server.id);
  });
  inflight.set(server.id, p);
  return p;
}

/**
 * ssh client errors that mean "we never reached the server". Everything the
 * ssh CLIENT prints before a connection exists starts with `ssh: ` or is a
 * banner/kex failure; anything after auth (password prompts, remote shell
 * output, `Permission denied`) is proof the server WAS reachable and must not
 * match.
 */
const CONNECT_FAILURE_RES: readonly RegExp[] = [
  /ssh: connect to host .+: (?:connection timed out|connection refused|no route to host|network is unreachable|operation timed out|host is down)/i,
  /ssh: could not resolve hostname/i,
  /connection timed out during banner exchange/i,
  /kex_exchange_identification: /i,
  /ssh_exchange_identification: /i,
];

/**
 * How much of the spawn's earliest output we keep. Only this PREFIX is ever
 * examined, which is what makes matching safe on long-lived panes: a
 * mid-session disconnect an hour in can never reach it. Raw bytes, so it must
 * be generous — ConPTY interleaves the text with escape sequences and repaint
 * noise, and the old 4KB cap could fill with that noise before the error text
 * itself arrived.
 */
const WATCH_RAW_CAP = 65536;

/**
 * VT noise → plain text. ConPTY does not forward the child's bytes verbatim:
 * it re-renders, splicing cursor moves, SGR runs and repaints INTO the text —
 * `Connection timed⟨ESC[K⟩ out` matches nothing as raw bytes even though the
 * screen reads fine. This is why the dev-server detector strips before
 * matching, and the watch must too. Whitespace collapses so repaint rows of
 * blank cells cannot pad the text apart.
 */
function stripVt(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI (incl. private + intermediates)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "") // OSC, BEL- or ST-terminated
    .replace(/\x1b./g, "") // remaining two-byte ESC sequences
    .replace(/[\x00-\x1f\x7f]+/g, " ") // controls (incl. \r\n) → whitespace
    .replace(/ {2,}/g, " ");
}

/**
 * Watches a remote pane's earliest output for fatal spawn verdicts — checked
 * from the pane's data handler (the error itself is the verdict; waiting for
 * the PTY exit event would make the card hostage to exit delivery) and again
 * at exit. One instance per spawn; `reset()` re-arms it for a restart.
 */
export class SshSpawnFailureWatch {
  private raw = "";
  private decoder = new TextDecoder();
  /** Clean of `raw` as of `cleanedAt` chars — recomputed only when raw grew,
   *  so once the prefix cap is reached every further call is free. */
  private cleanCache = "";
  private cleanedAt = -1;

  note(bytes: Uint8Array): void {
    if (this.raw.length >= WATCH_RAW_CAP) return;
    this.raw += this.decoder.decode(bytes, { stream: true });
    if (this.raw.length > WATCH_RAW_CAP) this.raw = this.raw.slice(0, WATCH_RAW_CAP);
  }

  private cleaned(): string {
    if (this.raw.length !== this.cleanedAt) {
      this.cleanCache = stripVt(this.raw);
      this.cleanedAt = this.raw.length;
    }
    return this.cleanCache;
  }

  /**
   * Did the CLI itself reject the resume id this pane spawned with? True when
   * the early output names `id` next to a "can't find / already exists"
   * verdict — e.g. Claude's `No conversation found with session ID: <id>`.
   * The server-side resume guard (terminal-config.ts) makes this rare; this
   * catches what the guard can't reach (cwd-less panes, slug mismatches), so
   * the pane can drop the dead id and respawn fresh instead of dying on the
   * error.
   */
  resumeFailure(id: string): boolean {
    if (!id) return false;
    const text = this.cleaned();
    if (!text.includes(id)) return false;
    return /no conversation found|already (?:in use|exists)/i.test(text);
  }

  /** The matched ssh error, or null while this spawn shows no pre-connection
   *  failure. */
  failure(): string | null {
    const text = this.cleaned();
    for (const re of CONNECT_FAILURE_RES) {
      const m = text.match(re);
      if (m) {
        // From the match to end-of-sentence-ish, so short pattern heads like
        // `kex_exchange_identification: ` still carry their reason text.
        const at = m.index ?? 0;
        return text.slice(at, at + 160).trim();
      }
    }
    return null;
  }

  /** First stretch of the cleaned prefix — for log lines when nothing matched. */
  sample(): string {
    return this.cleaned().slice(0, 160);
  }

  /** Raw bytes seen so far — cheap diagnostic for log lines. */
  rawLength(): number {
    return this.raw.length;
  }

  reset(): void {
    this.raw = "";
    this.decoder = new TextDecoder();
    this.cleanCache = "";
    this.cleanedAt = -1;
  }
}

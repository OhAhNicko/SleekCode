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
 * How much output we keep looking at. A pre-connection failure is a line or
 * two of ssh client stderr; once this much has arrived the connection
 * evidently succeeded and the watch retires itself.
 */
const WATCH_BYTE_CAP = 4096;

/**
 * Accumulates a remote pane's earliest output and answers, at exit time,
 * "did ssh die before it ever connected — and with what error?". One instance
 * per spawn; `reset()` re-arms it for a restart.
 */
export class SshSpawnFailureWatch {
  private buf = "";
  private seen = 0;
  private decoder = new TextDecoder();

  note(bytes: Uint8Array): void {
    if (this.seen >= WATCH_BYTE_CAP) return;
    this.seen += bytes.length;
    this.buf += this.decoder.decode(bytes, { stream: true });
    if (this.buf.length > WATCH_BYTE_CAP) this.buf = this.buf.slice(0, WATCH_BYTE_CAP);
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
    if (!id || this.seen >= WATCH_BYTE_CAP) return false;
    if (!this.buf.includes(id)) return false;
    return /no conversation found|already (?:in use|exists)/i.test(this.buf);
  }

  /** The matched ssh error line, or null if this exit was not a
   *  pre-connection failure. */
  failure(): string | null {
    if (this.seen >= WATCH_BYTE_CAP) return null;
    for (const re of CONNECT_FAILURE_RES) {
      const m = this.buf.match(re);
      if (m) {
        // Hand back the whole line the match sits on — "ssh: connect to host
        // 100.125.152.108 port 22: Connection timed out" is the diagnostic.
        const start = this.buf.lastIndexOf("\n", m.index ?? 0) + 1;
        const end = this.buf.indexOf("\n", m.index ?? 0);
        const line = this.buf.slice(start, end === -1 ? undefined : end).replace(/\r/g, "").trim();
        return line || m[0];
      }
    }
    return null;
  }

  reset(): void {
    this.buf = "";
    this.seen = 0;
    this.decoder = new TextDecoder();
  }
}

/**
 * macOS Keychain unlock for remote SSH panes.
 *
 * Claude Code stores its login in the macOS Keychain, which is locked for
 * non-GUI SSH sessions — and each SSH session gets its own security session,
 * so the unlock must happen inside every login, right before `exec claude`.
 *
 * Mechanism: `getKeychainUnlockPreamble()` is prepended to the remote command
 * of Claude panes (see `needsKeychainUnlock`). When — and only when — the
 * keychain is locked, it prints a READY sentinel and `read`s the password from
 * the PTY (stdin over the encrypted SSH channel — never in argv, never echoed
 * thanks to `stty -echo`); otherwise it prints SKIP and the watcher goes
 * dormant. `createKeychainUnlockWatcher()` watches the pane's output for the
 * sentinels and writes the password: from the in-memory session cache, or via
 * `UnlockKeychainModal` (the same dialog the server row's key icon opens),
 * which on key-auth servers verifies the password over an ssh round-trip
 * before resolving — a typo shows "Wrong password" inline instead of burning
 * the pane's tries.
 *
 * Cache invariant: nothing enters `passwords` except through a CONFIRMED
 * unlock — verifyKeychainPassword's "ok", or an OK sentinel in the pane
 * stream. Passwords live ONLY in this module's memory for the app run — they
 * are never persisted and must never be logged.
 */
import { invoke } from "@tauri-apps/api/core";
import { requestSpawnUnlock } from "./unlock-keychain-modal";
import { cleanOutput } from "./pty-text";
import type { RemoteServer, TerminalType } from "../types";

const READY = "[MADE] keychain-unlock ready";
const OK = "[MADE] keychain unlocked";
const FAIL = "[MADE] keychain unlock failed";
const SKIP = "[MADE] keychain-unlock skipped";

/**
 * Single source of truth for "does this pane get the unlock preamble AND its
 * watcher". Both sides MUST use it: a preamble without a watcher parks the pane
 * at the remote `read` with nothing to answer it (this was reachable — a
 * "token" server with no stored token got the preamble but no watcher).
 *
 * Claude panes only: the keychain item being unlocked is Claude Code's login
 * credential. Codex and gemini keep theirs in plain files (~/.codex/auth.json,
 * ~/.gemini/oauth_creds.json) that read fine over SSH, and shell/dev-server
 * panes don't sign in to anything — prompting there is pure noise. The cost is
 * one edge case: `claude` typed manually into a remote shell pane no longer
 * gets a pre-unlocked keychain (the key icon on the server row still covers it).
 */
export function needsKeychainUnlock(
  server: { claudeAuth?: string },
  terminalType: TerminalType,
): boolean {
  return terminalType === "claude" && (server.claudeAuth ?? "keychain") === "keychain";
}

/** Give up watching if this much output passes without a READY sentinel
 *  (non-macOS server: the `command -v security` guard skips the preamble). */
const NO_SENTINEL_GIVE_UP_BYTES = 65536;
const MAX_TRIES = 3;

/** serverId → password, session-memory only. */
const passwords = new Map<string, string>();
/** serverId → in-flight dialog, so N simultaneous panes share one prompt. */
const inflight = new Map<string, Promise<string | null>>();

export function clearKeychainPassword(serverId: string): void {
  passwords.delete(serverId);
}

/** Seed the session cache from outside the spawn-time watcher — the manual
 *  "Unlock keychain" dialog uses this after the server confirms the password. */
export function setKeychainPassword(serverId: string, password: string): void {
  passwords.set(serverId, password);
}

export type KeychainVerdict = "ok" | "bad" | "nomac";

/**
 * Ask the server whether this password really unlocks its login keychain, and
 * cache it only if it does.
 *
 * The unlock does not survive the round-trip (each ssh login gets its own
 * security session — see the module header), so this is a verification, not a
 * fix. It exists because the cached password is answered blindly into the next
 * pane's `read`: a typo there costs three silent failures and a Claude login
 * screen, while here it costs one red line.
 *
 * Rejects when ssh itself fails; the caller shows that message as-is.
 */
export async function verifyKeychainPassword(
  server: RemoteServer,
  password: string,
): Promise<KeychainVerdict> {
  const verdict = await invoke<string>("ssh_unlock_keychain", {
    host: server.host,
    username: server.username,
    identityFile:
      server.authMethod === "ssh-key" && server.sshKeyPath ? server.sshKeyPath : null,
    password,
  });
  if (verdict === "ok") setKeychainPassword(server.id, password);
  return verdict === "ok" || verdict === "bad" || verdict === "nomac" ? verdict : "bad";
}

/**
 * Shell preamble that unlocks the login keychain before the real command —
 * but ONLY when unlocking would actually change anything. The password loop
 * runs solely when the keychain is LOCKED; every other reason the credential
 * probe can fail is skipped, because `unlock-keychain` cannot fix it and the
 * prompt would fire on every connect forever:
 *
 *   1. `~/.claude/.credentials.json` carries a `claudeAiOauth` block — Claude
 *      signed in via its file fallback, so the keychain is irrelevant. (This
 *      was the phantom prompt: it asked on every start, yet Cancel left Claude
 *      working.) The marker is checked, NOT mere existence of the file: Claude
 *      writes that same file for MCP-server OAuth alone (`mcpOAuth`, e.g. after
 *      MADE installs the Jira MCP), and on a Mac whose own login lives in the
 *      Keychain that left an mcpOAuth-only file behind — existence then made
 *      this guard fire on a machine that was NOT signed in, so the preamble
 *      printed SKIP, no dialog ever opened, and every remote Claude pane came
 *      up at the login screen with no way to answer it.
 *   2. The secret reads fine — keychain unlocked and accessible, nothing to do.
 *   3. `show-keychain-info` succeeds — the keychain is UNLOCKED, so the probe
 *      in 2 failed for a reason unlocking can't cure: the item doesn't exist,
 *      or its ACL denies /usr/bin/security.
 *
 * Only when all three miss (= locked) does READY print and the dialog open;
 * otherwise a self-erasing SKIP sentinel tells the watcher to go dormant.
 *
 * Single line, POSIX-sh/bash/zsh safe; a no-op on servers without `security`.
 * `stty -echo` runs BEFORE the READY sentinel, so the password MADE writes is
 * never echoed back into the pane. After MAX_TRIES failures it gives up and
 * lets the real command run anyway (Claude then shows its own login).
 */
export function getKeychainUnlockPreamble(): string {
  // Sentinels are printed WITHOUT newlines and erased in place (\r + CSI 2K):
  // the watcher still sees every byte in the stream, but nothing lingers on
  // screen. Deliberately NOT hidden via APC/DCS wrapping — ConPTY on the
  // Windows side re-renders the stream and drops such sequences wholesale,
  // which would blind the watcher. Plain text + erase survives it.
  //
  // READY erases itself in the SAME printf rather than waiting for the next
  // sentinel to erase it. It used to carry no erase, so it sat on screen for
  // the entire time the password dialog was open — the pane's first paint was
  // "[MADE] keychain-unlock ready" for as long as the user took to type. The
  // bytes still reach the watcher either way; only the rendering changes.
  //
  // Guard order = cheapest first; `||` short-circuits, so the two `security`
  // calls never run when the creds file already proves Claude is signed in.
  return (
    "if command -v security >/dev/null 2>&1; then " +
    // `grep -q claudeAiOauth`, never `[ -f … ]`: the file's mere presence
    // proves nothing about Claude's OWN login — an MCP server's OAuth state
    // lives in the same file under `mcpOAuth`. Unquoted pattern on purpose (no
    // shell metacharacters), so it survives the ssh argv → remote-shell trip
    // without another quoting layer.
    "if grep -q claudeAiOauth ~/.claude/.credentials.json 2>/dev/null || " +
    "security find-generic-password -s 'Claude Code-credentials' -w >/dev/null 2>&1 || " +
    "security show-keychain-info ~/Library/Keychains/login.keychain-db >/dev/null 2>&1; then " +
    `printf '${SKIP}\\r\\033[2K'; ` +
    "else " +
    "stty -echo 2>/dev/null; __kt=0; " +
    `while [ $__kt -lt ${MAX_TRIES} ]; do ` +
    `printf '${READY}\\r\\033[2K'; ` +
    "IFS= read -r MADE_PW; " +
    'if security unlock-keychain -p "$MADE_PW" ~/Library/Keychains/login.keychain-db 2>/dev/null; then ' +
    `printf '\\r\\033[2K${OK}'; break; fi; ` +
    `printf '\\r\\033[2K${FAIL}'; __kt=$((__kt+1)); done; ` +
    "printf '\\r\\033[2K'; stty echo 2>/dev/null; unset MADE_PW __kt; fi; fi;"
  );
}

async function requestPassword(
  server: { id: string; name: string; username: string },
  isRetry: boolean,
): Promise<string | null> {
  const existing = inflight.get(server.id);
  if (existing) return existing;

  // Deliberately does NOT cache the answer. Nothing enters `passwords` except
  // through a confirmed unlock: verifyKeychainPassword's "ok" (the dialog
  // verifies before resolving on key-auth servers), or the OK sentinel the
  // watcher sees in the pane stream. Caching at dialog-resolution let a typo
  // survive the whole app run whenever the FAIL sentinel went unseen.
  const p = requestSpawnUnlock(server.id, isRetry).then((pw) => {
    inflight.delete(server.id);
    return pw ? pw : null;
  });
  inflight.set(server.id, p);
  return p;
}

/**
 * Per-spawn output watcher. Feed it every PTY chunk; it answers the preamble's
 * READY sentinels with the cached/prompted password and goes dormant once the
 * keychain is unlocked (or unlockable). The `write` callback must deliver text
 * into that same PTY.
 */
export function createKeychainUnlockWatcher(
  server: { id: string; name: string; username: string },
  write: (data: string) => void,
): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder();
  let pending = "";
  let bytesSeen = 0;
  let sawReady = false;
  let wrongPassword = false;
  let cancelled = false;
  let fails = 0;
  let done = false;
  // The password most recently written into the remote `read`, cached ONLY
  // when the OK sentinel proves the unlock succeeded. Null while nothing is
  // outstanding (cancel writes a bare \r; FAIL disproves the last write).
  let lastWritten: string | null = null;
  // Only ONE remote `read` is ever outstanding, so each write must answer the
  // LATEST READY exactly once. Without this, a FAIL/READY cycle overlapping an
  // open dialog would double-write — and the stray line lands in the remote
  // command's stdin (i.e. the password typed into Claude's composer).
  let readyGen = 0;
  let answeredGen = 0;

  const respond = async (gen: number) => {
    if (done || gen <= answeredGen) return;
    if (cancelled) {
      // Burn the remote loop's remaining tries so the pane still reaches its
      // real command instead of hanging on `read`.
      answeredGen = gen;
      lastWritten = null;
      write("\r");
      return;
    }
    const cached = passwords.get(server.id);
    if (cached !== undefined && !wrongPassword) {
      answeredGen = gen;
      lastWritten = cached;
      write(cached + "\r");
      return;
    }
    const pw = await requestPassword(server, wrongPassword);
    wrongPassword = false;
    if (done) return;
    const target = readyGen;
    if (answeredGen >= target) return;
    answeredGen = target;
    if (pw === null) {
      cancelled = true;
      lastWritten = null;
      write("\r");
      return;
    }
    lastWritten = pw;
    write(pw + "\r");
  };

  return (chunk: Uint8Array) => {
    if (done) return;
    bytesSeen += chunk.length;
    pending += cleanOutput(decoder.decode(chunk, { stream: true }));

    for (;;) {
      // Earliest sentinel first — a FAIL is always followed by the next READY.
      const hits = [
        { i: pending.indexOf(SKIP), s: SKIP },
        { i: pending.indexOf(FAIL), s: FAIL },
        { i: pending.indexOf(OK), s: OK },
        { i: pending.indexOf(READY), s: READY },
      ]
        .filter((h) => h.i !== -1)
        .sort((a, b) => a.i - b.i);
      const hit = hits[0];
      if (!hit) break;
      pending = pending.slice(hit.i + hit.s.length);

      if (hit.s === SKIP) {
        // Preamble decided unlocking can't help (creds file, already unlocked,
        // missing item, ACL). Dormant immediately — no 64KB of chunk scanning.
        done = true;
        return;
      }
      if (hit.s === OK) {
        // The pane just PROVED the last written password unlocks the keychain
        // — the only confirmation the in-band (password-auth) path ever gets.
        if (lastWritten !== null) passwords.set(server.id, lastWritten);
        done = true;
        return;
      }
      if (hit.s === FAIL) {
        clearKeychainPassword(server.id);
        lastWritten = null;
        wrongPassword = true;
        fails++;
        if (fails >= MAX_TRIES) {
          done = true;
          return;
        }
        continue;
      }
      // READY
      sawReady = true;
      readyGen++;
      void respond(readyGen);
    }

    if (!sawReady && bytesSeen > NO_SENTINEL_GIVE_UP_BYTES) {
      done = true;
      pending = "";
      return;
    }
    // Keep only enough tail to catch a sentinel split across chunks.
    if (pending.length > 256) pending = pending.slice(-64);
  };
}

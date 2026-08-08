import { useCallback, useEffect, useRef, useState } from "react";
import LoadingDots from "./LoadingDots";
import { useAppStore } from "../store";
import { useModalWhen } from "../store/modalCoordinationSlice";
import { MODAL_BACKDROP } from "../lib/modal-layout";
import {
  UNLOCK_KEYCHAIN_EVENT,
  type UnlockKeychainRequest,
} from "../lib/unlock-keychain-modal";
import { verifyKeychainPassword } from "../lib/keychain";
import { getTerminalActions } from "../lib/terminal-actions";
import type { TerminalInstance } from "../types";

/**
 * The "Unlock Keychain" dialog for a remote server — BOTH entry points:
 *
 * Manual (key icon / context menu): verify the password over an ssh
 * round-trip, then offer to restart the server's Claude panes so they re-run
 * the preamble with the cached password (session ids survive; see
 * handleRestart in TerminalPaneXterm/Native).
 *
 * Spawn (`requestSpawnUnlock`): a just-spawned pane is waiting at the
 * preamble's `read`. On key-auth servers the password is STILL verified
 * before it is resolved back — a typo shows "Wrong password" inline while the
 * dialog stays open, instead of burning one of the pane's three tries. On
 * password-auth servers verification is impossible (BatchMode ssh), so the
 * value resolves unverified and the pane's own FAIL sentinel re-opens this
 * dialog with the error note. Success resolves and closes — the pane proceeds
 * the moment its `read` is answered; there is nothing to restart.
 *
 * The spawn resolver must fire EXACTLY ONCE on every exit path (cancel,
 * Escape, backdrop, server deleted, displaced by a newer request): an
 * orphaned resolver leaves the pane hanging at `read` forever.
 *
 * Mounted once in App, like PromptModal, and for the same two reasons: the
 * dialog needs real keyboard focus (impossible in the WS_EX_NOACTIVATE overlay
 * webview), and `useModalWhen` must hide the native panes while it is open —
 * they are child HWNDs that would otherwise paint straight over it.
 */

// Claude only: the keychain item is Claude Code's login credential, and since
// the preamble is claude-pane-only (needsKeychainUnlock), restarting a
// codex/gemini pane would re-run no preamble and sign nothing in.
const CLI_TYPES = new Set<TerminalInstance["type"]>(["claude"]);

type Phase = "input" | "verifying" | "verified";
type Note = { kind: "error" | "info"; text: string };

/** A pane the restart step will actually reach. */
interface Candidate {
  id: string;
  type: TerminalInstance["type"];
  where: string;
}

function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/**
 * Claude panes on this server that can restart right now.
 *
 * Only Claude panes carry the unlock preamble (needsKeychainUnlock), so only
 * they gain anything from a restart. The `getTerminalActions` check keeps the
 * count honest — an unregistered pane cannot restart, so it must not be
 * counted as one that will. Panes in background tabs are fine; App renders
 * inactive tabs with `display:none` rather than unmounting them.
 */
function restartCandidates(serverId: string): Candidate[] {
  return Object.values(useAppStore.getState().terminals)
    .filter((t) => t.serverId === serverId && CLI_TYPES.has(t.type) && !!getTerminalActions(t.id))
    .map((t) => ({ id: t.id, type: t.type, where: basename(t.workingDir) }));
}

export default function UnlockKeychainModal() {
  const [serverId, setServerId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("input");
  const [value, setValue] = useState("");
  const [note, setNote] = useState<Note | null>(null);
  // Frozen when verification succeeds, so the count cannot shift under the
  // pointer between reading the button and pressing it.
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  // Spawn mode: a pane is parked at the preamble's `read`, waiting on the
  // resolver in spawnRef. State (for rendering) and ref (for the resolver)
  // are set together in the event handler.
  const [spawnMode, setSpawnMode] = useState(false);
  const spawnRef = useRef<NonNullable<UnlockKeychainRequest["spawn"]> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Bumped on every close; a verification that resolves after the dialog is
  // gone (or reopened) must not write into it.
  const runRef = useRef(0);

  const server = useAppStore((s) => s.servers.find((x) => x.id === serverId));

  useModalWhen("unlock-keychain-modal", !!serverId);

  // Fires the pending spawn resolver exactly once; the null-out makes every
  // later call a no-op, so close paths can call it unconditionally.
  const resolveSpawn = useCallback((pw: string | null) => {
    const s = spawnRef.current;
    spawnRef.current = null;
    s?.resolve(pw);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<UnlockKeychainRequest>).detail;
      // A displaced spawn request must not be orphaned — its pane is waiting.
      // Resolve-null just burns one of that pane's tries.
      resolveSpawn(null);
      runRef.current++;
      spawnRef.current = detail.spawn ?? null;
      setSpawnMode(!!detail.spawn);
      setPhase("input");
      setValue("");
      setNote(
        detail.spawn?.isRetry ? { kind: "error", text: "Wrong password — try again." } : null,
      );
      setCandidates([]);
      setServerId(detail.serverId);
    };
    window.addEventListener(UNLOCK_KEYCHAIN_EVENT, handler);
    return () => window.removeEventListener(UNLOCK_KEYCHAIN_EVENT, handler);
  }, [resolveSpawn]);

  useEffect(() => {
    if (!serverId || phase !== "input") return;
    const t = setTimeout(() => {
      inputRef.current?.focus();
      // After a rejected attempt the old value is still there — select it so
      // the retry types over it instead of appending to a wrong password.
      if (note?.kind === "error") inputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, [serverId, phase, note]);

  const close = useCallback(() => {
    resolveSpawn(null);
    runRef.current++;
    setServerId(null);
    setValue("");
    setNote(null);
    setPhase("input");
    setCandidates([]);
    setSpawnMode(false);
  }, [resolveSpawn]);

  const verify = useCallback(async () => {
    if (!server || !value) return;
    const canOob = server.authMethod === "ssh-key" && !!server.sshKeyPath;
    if (spawnMode && !canOob) {
      // Password-auth server: BatchMode ssh cannot verify out-of-band. The
      // pane's own unlock loop is the validator — a FAIL sentinel re-opens
      // this dialog with the error note, and nothing is cached before OK.
      resolveSpawn(value);
      close();
      return;
    }
    const run = runRef.current;
    setPhase("verifying");
    setNote(null);
    try {
      const verdict = await verifyKeychainPassword(server, value);
      if (run !== runRef.current) return;
      if (verdict === "ok") {
        if (spawnMode) {
          // verifyKeychainPassword cached it (a confirmed unlock). The pane is
          // waiting at `read` — resolve and get out of its way; nothing to
          // restart, so the manual mode's verified phase is skipped.
          resolveSpawn(value);
          close();
          return;
        }
        setCandidates(restartCandidates(server.id));
        setValue("");
        setPhase("verified");
        return;
      }
      if (spawnMode && verdict === "nomac") {
        // Can't verify against a machine without a keychain; hand the value to
        // the in-band loop, which is about to be skipped by `command -v
        // security` anyway. Never cached from here (cache-on-OK only).
        resolveSpawn(value);
        close();
        return;
      }
      setPhase("input");
      setNote(
        verdict === "bad"
          ? { kind: "error", text: "Wrong password — try again." }
          : { kind: "info", text: `${server.name} has no keychain to unlock — it isn't macOS.` },
      );
    } catch (e) {
      if (run !== runRef.current) return;
      if (spawnMode) {
        // ssh itself failed (network blip, host key change…). Fall back to the
        // in-band FAIL loop as validator rather than blocking the pane on a
        // side channel; the unverified value is never cached from here.
        resolveSpawn(value);
        close();
        return;
      }
      setPhase("input");
      setNote({ kind: "error", text: String(e) });
    }
  }, [server, value, spawnMode, resolveSpawn, close]);

  const restart = useCallback(() => {
    for (const c of candidates) getTerminalActions(c.id)?.restart();
    close();
  }, [candidates, close]);

  // The server can be deleted while the dialog is open.
  useEffect(() => {
    if (serverId && !server) close();
  }, [serverId, server, close]);

  if (!serverId || !server) return null;

  const canVerify = phase === "input" && value.length > 0;
  // Password-auth spawn requests skip the verify round-trip, so the primary
  // button must not promise one.
  const verifies = !spawnMode || (server.authMethod === "ssh-key" && !!server.sshKeyPath);
  const muted = "var(--ezy-text-muted, rgba(230,237,243,0.6))";

  return (
    <div
      style={{ ...MODAL_BACKDROP, zIndex: 300, background: "rgba(0,0,0,0.55)" }}
      onClick={close}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          } else if (e.key === "Enter") {
            if (phase === "verified" && candidates.length > 0) {
              e.stopPropagation();
              restart();
            } else if (canVerify) {
              e.stopPropagation();
              void verify();
            }
          }
        }}
        style={{
          width: 380,
          maxWidth: "calc(100vw - 32px)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 10px)",
          overflow: "hidden",
          background: "var(--ezy-surface-raised, #1c2128)",
          border: "1px solid var(--ezy-border, rgba(255,255,255,0.1))",
          boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
          color: "var(--ezy-text, #e6edf3)",
          fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
        }}
      >
        <div style={{ padding: "16px 18px 12px" }}>
          {phase !== "verified" ? (
            <>
              <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 14px)", fontWeight: 600 }}>Unlock Keychain</div>
              <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", marginTop: 6, lineHeight: 1.45, color: muted }}>
                {spawnMode
                  ? `A Claude pane on ${server.name} is waiting for the keychain. Never stored.`
                  : `Keeps Claude signed in on ${server.name}. Never stored.`}
              </div>
              <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", marginTop: 14, marginBottom: 5, color: muted }}>
                Password for {server.username}
              </div>
              <input
                ref={inputRef}
                type="password"
                value={value}
                disabled={phase === "verifying"}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
                autoComplete="new-password"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "7px 10px",
                  fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                  outline: "none",
                  background: "var(--ezy-surface, #161b22)",
                  border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
                  color: "var(--ezy-text, #e6edf3)",
                  opacity: phase === "verifying" ? 0.5 : 1,
                }}
              />
              {note && (
                <div
                  style={{
                    fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                    marginTop: 6,
                    lineHeight: 1.4,
                    color: note.kind === "error" ? "#e5534b" : muted,
                  }}
                >
                  {note.text}
                </div>
              )}
            </>
          ) : (
            <>
              {/* The dialog does not close on success — it turns into the next
                  action. Ring pops, tick draws, the primary button re-labels. */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <svg
                  className="check-pop-in"
                  width="26"
                  height="26"
                  viewBox="0 0 26 26"
                  fill="none"
                  style={{ flexShrink: 0 }}
                  aria-hidden="true"
                >
                  <circle cx="13" cy="13" r="11" stroke="#4ade80" strokeWidth="1.5" />
                  <path
                    className="check-draw"
                    d="M8 13.4l3.2 3.2L18 9.8"
                    pathLength="1"
                    stroke="#4ade80"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <div>
                  <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 14px)", fontWeight: 600 }}>Password verified</div>
                  <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", marginTop: 2, lineHeight: 1.45, color: muted }}>
                    Saved for {server.name} until MADE closes.
                  </div>
                </div>
              </div>
              {candidates.length > 0 ? (
                <>
                  <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 11px)", marginTop: 14, marginBottom: 6, color: muted }}>
                    Restart these panes to sign in — they resume the same sessions.
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      maxHeight: 132,
                      overflowY: "auto",
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                      border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
                      background: "var(--ezy-surface, #161b22)",
                      padding: "6px 8px",
                    }}
                  >
                    {candidates.map((c) => (
                      <div
                        key={c.id}
                        style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "calc(var(--ezy-font-scale, 1) * 12px)" }}
                      >
                        <span style={{ minWidth: 46, color: "var(--ezy-text, #e6edf3)" }}>
                          {c.type}
                        </span>
                        <span
                          style={{
                            color: muted,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c.where}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", marginTop: 14, lineHeight: 1.45, color: muted }}>
                  Your next remote pane on {server.name} unlocks without asking.
                </div>
              )}
            </>
          )}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 18px 14px",
          }}
        >
          <button
            onClick={close}
            style={{
              padding: "6px 14px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
              cursor: "pointer",
              border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
              background: "transparent",
              color: "var(--ezy-text, #e6edf3)",
            }}
          >
            {phase === "verified" ? "Done" : "Cancel"}
          </button>
          {/* Hidden on a verified server with no CLI panes: there is nothing to
              restart, so the row would be an action that can never apply. */}
          {(phase !== "verified" || candidates.length > 0) && (
            <button
              disabled={phase === "verified" ? false : !canVerify}
              onClick={phase === "verified" ? restart : () => void verify()}
              style={{
                padding: "6px 14px",
                fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                fontWeight: 600,
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                border: "none",
                cursor: phase === "verified" || canVerify ? "pointer" : "default",
                opacity: phase === "verified" || canVerify ? 1 : 0.45,
                background: "var(--ezy-accent, #10a37f)",
                color: "#fff",
              }}
            >
              {phase === "verified"
                ? `Restart ${candidates.length} ${candidates.length === 1 ? "pane" : "panes"}`
                : phase === "verifying"
                  ? <LoadingDots>Verifying</LoadingDots>
                  : verifies
                    ? "Verify & Unlock"
                    : "Unlock"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

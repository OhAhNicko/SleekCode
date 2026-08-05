import { useState, useEffect, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { useModal } from "../store/modalCoordinationSlice";
import { getSshInstallKeyCommand } from "../lib/terminal-config";
import { cleanOutput } from "../lib/pty-text";
import { MODAL_BACKDROP } from "../lib/modal-layout";

/**
 * Step-by-step SSH key setup: generate a keypair locally, install the public
 * key on the server, verify key-only login works. The actual work happens in a
 * HIDDEN PTY (ssh.exe on Windows — never WSL); the user only ever sees this
 * GUI, including a masked dialog for the server password. Every failure mode
 * maps to an explicit phase with actionable guidance and a retry.
 */

interface SshKeySetupWizardModalProps {
  server: { id: string; name: string; host: string; username: string };
  /** Called with the ABSOLUTE private-key path once install + verify succeed. */
  onComplete: (absoluteKeyPath: string) => void;
  onClose: () => void;
}

type Phase =
  | "preparing"
  | "connecting"
  | "password"
  | "installing"
  | "verifying"
  | "done"
  | "refused"
  | "unreachable"
  | "hostKeyChanged"
  | "sshUnavailable"
  | "error";

type RefusedOs = "mac" | "linux" | "windows";

interface SshEnsureKeyResult {
  key_path: string;
  public_key: string;
  created: boolean;
}

/** Compute a deterministic SSH key path from server name + short ID suffix.
 *  Returned with `~` — the Rust side expands it to the real home dir. */
function getKeyPath(serverName: string, serverId: string): string {
  const sanitized = serverName.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const suffix = serverId.replace("srv-", "").slice(-6);
  return `~/.ssh/made_${sanitized}_${suffix}_ed25519`;
}

const CONNECT_TIMEOUT_MS = 30_000;
const INSTALLED_SENTINEL = "__MADE_KEY_INSTALLED__";

const STEPS: { key: string; label: string }[] = [
  { key: "preparing", label: "Generate SSH key" },
  { key: "connecting", label: "Connect to server" },
  { key: "password", label: "Authorize with password" },
  { key: "installing", label: "Install key on server" },
  { key: "verifying", label: "Verify key login" },
];

/** Index of the step a phase belongs to; terminal/error phases return -1. */
function stepIndexOf(phase: Phase): number {
  const i = STEPS.findIndex((s) => s.key === phase);
  return i;
}

export default function SshKeySetupWizardModal({ server, onComplete, onClose }: SshKeySetupWizardModalProps) {
  useModal("ssh-key-setup-wizard");

  const [phase, setPhase] = useState<Phase>("preparing");
  const [passwordValue, setPasswordValue] = useState("");
  const [passwordNote, setPasswordNote] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [rawOutput, setRawOutput] = useState("");
  const [showOutput, setShowOutput] = useState(false);
  const [refusedOs, setRefusedOs] = useState<RefusedOs | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const phaseRef = useRef<Phase>("preparing");
  const ptyIdRef = useRef<number | null>(null);
  const bytesRef = useRef<number[]>([]);
  const keyPathRef = useRef<string>("");
  const deniedCountRef = useRef(0);
  const yesWrittenRef = useRef(false);
  /** Highest step reached, so error screens keep the progress list honest. */
  const maxStepRef = useRef(0);

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const serverRef = useRef(server);
  serverRef.current = server;

  const toPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    const idx = stepIndexOf(p);
    if (idx > maxStepRef.current) maxStepRef.current = idx;
    setPhase(p);
  }, []);

  const killPty = useCallback(() => {
    const id = ptyIdRef.current;
    if (id !== null) {
      invoke("pty_kill", { ptyId: id }).catch(() => {});
      ptyIdRef.current = null;
    }
  }, []);

  const fail = useCallback(
    (p: Phase, msg?: string) => {
      if (phaseRef.current === "done" || phaseRef.current === p) return;
      if (msg !== undefined) setErrorMsg(msg);
      toPhase(p);
      killPty();
    },
    [killPty, toPhase],
  );

  const beginVerify = useCallback(async () => {
    toPhase("verifying");
    killPty();
    const srv = serverRef.current;
    try {
      const ok = await invoke<boolean>("ssh_test_connection", {
        host: srv.host,
        username: srv.username,
        identityFile: keyPathRef.current,
      });
      if (phaseRef.current !== "verifying") return;
      if (ok) {
        onCompleteRef.current(keyPathRef.current);
        toPhase("done");
      } else {
        fail(
          "error",
          "The key was installed but key-based login still fails. Check the server's sshd config (AuthorizedKeysFile) and that the home directory is not group-writable, then retry.",
        );
      }
    } catch (e) {
      if (phaseRef.current === "verifying") fail("error", `Verification failed: ${String(e)}`);
    }
  }, [fail, killPty, toPhase]);

  // One setup attempt per retryNonce: ensure key, then install via hidden PTY.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const srv = serverRef.current;
        const key = await invoke<SshEnsureKeyResult>("ssh_ensure_key", {
          keyPath: getKeyPath(srv.name, srv.id),
        });
        if (cancelled) return;
        keyPathRef.current = key.key_path;

        const { command, args } = getSshInstallKeyCommand(srv, key.public_key);

        const onData = new Channel<ArrayBuffer>();
        onData.onmessage = (buf) => {
          const bytes = new Uint8Array(buf);
          for (let i = 0; i < bytes.length; i++) bytesRef.current.push(bytes[i]);
          const text = cleanOutput(new TextDecoder().decode(new Uint8Array(bytesRef.current)));
          setRawOutput(text);

          const p = phaseRef.current;
          if (p !== "connecting" && p !== "password" && p !== "installing") return;

          if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
            fail("hostKeyChanged");
            return;
          }
          if (/Connection refused/i.test(text)) {
            fail("refused");
            return;
          }
          if (/(Could not resolve hostname|Connection timed out|Operation timed out|No route to host|Network is unreachable)/i.test(text)) {
            fail("unreachable");
            return;
          }
          if (text.includes(INSTALLED_SENTINEL)) {
            void beginVerify();
            return;
          }
          // Final rejection ("Permission denied (publickey,password)." — with
          // paren, unlike the retryable "please try again" line).
          if (/Permission denied \(/i.test(text)) {
            fail(
              "error",
              "The server rejected the password. If it only allows key-based login, copy the public key from the Servers panel and add it to ~/.ssh/authorized_keys manually.",
            );
            return;
          }

          const denials = text.split("please try again").length - 1;
          if (denials > deniedCountRef.current) {
            deniedCountRef.current = denials;
            setPasswordNote("Wrong password — try again.");
          }

          const tail = text.slice(-200);
          if (!yesWrittenRef.current && /continue connecting/i.test(tail) && /\?\s*$/.test(tail)) {
            // Fallback for old ssh without StrictHostKeyChecking=accept-new.
            yesWrittenRef.current = true;
            const id = ptyIdRef.current;
            if (id !== null) invoke("pty_write", { ptyId: id, data: "yes\r" }).catch(() => {});
            return;
          }
          // "user@host's password: " (password auth) or "Password:" (macOS
          // keyboard-interactive via PAM) sitting at the end of the stream.
          if (/password:\s*$/i.test(tail)) {
            toPhase("password");
          }
        };

        const onExit = new Channel<number>();
        onExit.onmessage = () => {
          const p = phaseRef.current;
          if (p === "connecting" || p === "password" || p === "installing") {
            fail("error", "The SSH session ended before the key was installed. Check the output below.");
          }
        };

        toPhase("connecting");
        const id = await invoke<number>("pty_spawn", {
          command,
          args,
          cols: 120,
          rows: 30,
          cwd: null,
          env: { TERM: "xterm-256color" },
          onData,
          onExit,
        });
        if (cancelled) {
          invoke("pty_kill", { ptyId: id }).catch(() => {});
          return;
        }
        ptyIdRef.current = id;
      } catch (e) {
        if (cancelled) return;
        const msg = String(e);
        if (/ssh-keygen|program not found|No such file|cannot find/i.test(msg)) {
          setErrorMsg(msg);
          fail("sshUnavailable");
        } else {
          fail("error", msg);
        }
      }
    })();

    return () => {
      cancelled = true;
      killPty();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  // Stall timeout while waiting on the network — paused during user input.
  useEffect(() => {
    if (phase !== "connecting" && phase !== "installing") return;
    const t = setTimeout(
      () => fail("unreachable"),
      CONNECT_TIMEOUT_MS,
    );
    return () => clearTimeout(t);
  }, [phase, fail]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const submitPassword = useCallback(() => {
    const id = ptyIdRef.current;
    if (id === null || !passwordValue) return;
    invoke("pty_write", { ptyId: id, data: passwordValue + "\r" }).catch(() => {});
    setPasswordValue("");
    setPasswordNote("");
    toPhase("installing");
  }, [passwordValue, toPhase]);

  const retry = useCallback(() => {
    killPty();
    bytesRef.current = [];
    deniedCountRef.current = 0;
    yesWrittenRef.current = false;
    maxStepRef.current = 0;
    setRawOutput("");
    setErrorMsg("");
    setPasswordValue("");
    setPasswordNote("");
    setRefusedOs(null);
    phaseRef.current = "preparing";
    setPhase("preparing");
    setRetryNonce((n) => n + 1);
  }, [killPty]);

  const forgetHostAndRetry = useCallback(async () => {
    try {
      await invoke("ssh_forget_host", { host: serverRef.current.host });
    } catch {
      // ssh-keygen -R failing (host absent) is fine — retry regardless.
    }
    retry();
  }, [retry]);

  const currentStep = stepIndexOf(phase);
  const isErrorPhase =
    phase === "refused" || phase === "unreachable" || phase === "hostKeyChanged" || phase === "sshUnavailable" || phase === "error";

  return (
    <div
      style={{
        ...MODAL_BACKDROP,
        backgroundColor: "rgba(0,0,0,0.6)",
        zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        style={{
          maxWidth: 520,
          width: "100%",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 10px)",
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            height: 36,
            padding: "0 16px",
            borderBottom: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", fontWeight: 600, color: "var(--ezy-text)" }}>
            Set up SSH key — {server.name}
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.5"
            strokeLinecap="round"
            style={{ cursor: "pointer" }}
            onClick={onClose}
          >
            <line x1="4" y1="4" x2="12" y2="12" />
            <line x1="12" y1="4" x2="4" y2="12" />
          </svg>
        </div>

        {/* Body */}
        <div style={{ padding: 16 }}>
          {/* Step list */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
            {STEPS.map((s, i) => {
              const isDone = phase === "done" || i < (isErrorPhase ? maxStepRef.current : currentStep);
              const isCurrent = !isErrorPhase && phase !== "done" && i === currentStep;
              const isFailedHere = isErrorPhase && i === maxStepRef.current;
              return (
                <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: "50%",
                      flexShrink: 0,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: isDone
                        ? "var(--ezy-accent)"
                        : isFailedHere
                          ? "var(--ezy-red)"
                          : isCurrent
                            ? "var(--ezy-accent-dim)"
                            : "var(--ezy-border)",
                    }}
                  >
                    {isDone && (
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                    {isFailedHere && (
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round">
                        <line x1="6" y1="6" x2="18" y2="18" />
                        <line x1="18" y1="6" x2="6" y2="18" />
                      </svg>
                    )}
                  </span>
                  <span
                    style={{
                      fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                      color: isCurrent ? "var(--ezy-text)" : isDone ? "var(--ezy-text-secondary)" : "var(--ezy-text-muted)",
                      fontWeight: isCurrent ? 600 : 400,
                    }}
                  >
                    {s.label}
                    {isCurrent && "…"}
                  </span>
                </div>
              );
            })}
          </div>

          {phase === "preparing" && (
            <div style={mutedTextStyle}>
              Creating an ed25519 key for <strong style={{ color: "var(--ezy-text-secondary)" }}>{server.name}</strong> in
              your <code style={inlineCodeStyle}>~/.ssh</code> folder (reused if it already exists)…
            </div>
          )}

          {phase === "connecting" && (
            <div style={mutedTextStyle}>
              Connecting to{" "}
              <strong style={{ color: "var(--ezy-text-secondary)" }}>
                {server.username}@{server.host}
              </strong>
              … The connection runs in a hidden terminal — you never have to touch it.
            </div>
          )}

          {phase === "password" && (
            <>
              <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text)", marginBottom: 6, fontWeight: 500 }}>
                Server password required
              </div>
              <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
                Enter the password for <strong>{server.username}</strong> on <strong>{server.name}</strong> to authorize
                installing the key. It is typed straight into the encrypted SSH session and never stored.
              </div>
              {passwordNote && (
                <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-red, #e55)", marginBottom: 8 }}>{passwordNote}</div>
              )}
              <input
                type="password"
                autoFocus
                autoComplete="new-password"
                value={passwordValue}
                onChange={(e) => setPasswordValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitPassword();
                }}
                placeholder="Server password"
                style={inputStyle}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button onClick={submitPassword} disabled={!passwordValue} style={buttonStyle(true, !passwordValue)}>
                  Continue
                </button>
                <button onClick={onClose} style={buttonStyle(false, false)}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {phase === "installing" && (
            <div style={mutedTextStyle}>Installing the public key into the server's authorized keys…</div>
          )}

          {phase === "verifying" && (
            <div style={mutedTextStyle}>Key installed. Confirming that key-based login works…</div>
          )}

          {phase === "done" && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ezy-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              <span style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 13px)", color: "var(--ezy-text)" }}>
                SSH key set up and verified. This server now logs in without a password.
              </span>
            </div>
          )}

          {phase === "refused" && (
            <>
              <div style={errorTextStyle}>
                The server refused the connection — SSH remote login is probably not enabled on it.
              </div>
              <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-secondary)", marginBottom: 8 }}>
                Which system does <strong>{server.name}</strong> run?
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                {(
                  [
                    ["mac", "macOS"],
                    ["linux", "Linux"],
                    ["windows", "Windows"],
                  ] as [RefusedOs, string][]
                ).map(([os, label]) => (
                  <button
                    key={os}
                    onClick={() => setRefusedOs(os)}
                    style={{
                      ...buttonStyle(refusedOs === os, false),
                      padding: "6px 12px",
                      fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {refusedOs === "mac" && (
                <GuideBlock
                  steps={[
                    <>On the server, open <strong>System Settings → General → Sharing</strong>.</>,
                    <>Turn on <strong>Remote Login</strong> and allow access for <strong>{server.username}</strong>.</>,
                    <>Or run in a terminal on the server: <code style={inlineCodeStyle}>sudo systemsetup -setremotelogin on</code></>,
                  ]}
                />
              )}
              {refusedOs === "linux" && (
                <GuideBlock
                  steps={[
                    <>Install the SSH server: <code style={inlineCodeStyle}>sudo apt install openssh-server</code> (or your distro's equivalent).</>,
                    <>Enable and start it: <code style={inlineCodeStyle}>sudo systemctl enable --now ssh</code></>,
                  ]}
                />
              )}
              {refusedOs === "windows" && (
                <GuideBlock
                  steps={[
                    <>On the server, open <strong>Settings → System → Optional features</strong> and add <strong>OpenSSH Server</strong>.</>,
                    <>In an admin PowerShell: <code style={inlineCodeStyle}>Start-Service sshd; Set-Service sshd -StartupType Automatic</code></>,
                  ]}
                />
              )}
              {refusedOs && (
                <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-secondary)", marginBottom: 12 }}>
                  When that's done, retry below.
                </div>
              )}
              <RetryRow onRetry={retry} onClose={onClose} />
            </>
          )}

          {phase === "unreachable" && (
            <>
              <div style={errorTextStyle}>
                Could not reach <strong>{server.host}</strong>. Check that the hostname or IP is correct, the server is
                switched on, and both machines are on the same network (or Tailscale is running on both ends).
              </div>
              <RetryRow onRetry={retry} onClose={onClose} />
            </>
          )}

          {phase === "hostKeyChanged" && (
            <>
              <div style={errorTextStyle}>
                The server's identity changed since the last connection (this happens after a reinstall). If you trust
                this server, forget the old identity and retry.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={forgetHostAndRetry} style={buttonStyle(true, false)}>
                  Forget saved identity and retry
                </button>
                <button onClick={onClose} style={buttonStyle(false, false)}>
                  Close
                </button>
              </div>
            </>
          )}

          {phase === "sshUnavailable" && (
            <>
              <div style={errorTextStyle}>
                SSH tools were not found on this machine. On Windows, install them via{" "}
                <strong>Settings → System → Optional features → OpenSSH Client</strong>, then retry.
              </div>
              {errorMsg && <div style={{ ...mutedTextStyle, marginBottom: 12 }}>{errorMsg}</div>}
              <RetryRow onRetry={retry} onClose={onClose} />
            </>
          )}

          {phase === "error" && (
            <>
              <div style={errorTextStyle}>{errorMsg}</div>
              <RetryRow onRetry={retry} onClose={onClose} />
            </>
          )}

          {/* Raw-output safety net for debugging failed runs. */}
          {rawOutput && (
            <div style={{ marginTop: 16 }}>
              <button
                onClick={() => setShowOutput((v) => !v)}
                style={{
                  fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                  color: "var(--ezy-text-muted)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  fontFamily: "inherit",
                }}
              >
                {showOutput ? "Hide" : "Show"} terminal output
              </button>
              {showOutput && (
                <pre
                  style={{
                    marginTop: 8,
                    padding: 10,
                    fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                    lineHeight: 1.5,
                    color: "var(--ezy-text-secondary)",
                    backgroundColor: "var(--ezy-bg)",
                    border: "1px solid var(--ezy-border)",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                    maxHeight: 200,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  }}
                >
                  {rawOutput}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GuideBlock({ steps }: { steps: React.ReactNode[] }) {
  return (
    <ol style={{ margin: "0 0 12px", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
      {steps.map((s, i) => (
        <li key={i} style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 12px)", color: "var(--ezy-text-secondary)", lineHeight: 1.5 }}>
          {s}
        </li>
      ))}
    </ol>
  );
}

function RetryRow({ onRetry, onClose }: { onRetry: () => void; onClose: () => void }) {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <button onClick={onRetry} style={buttonStyle(true, false)}>
        Retry
      </button>
      <button onClick={onClose} style={buttonStyle(false, false)}>
        Close
      </button>
    </div>
  );
}

const mutedTextStyle: React.CSSProperties = {
  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
  color: "var(--ezy-text-muted)",
  padding: "4px 0",
  lineHeight: 1.5,
};

const errorTextStyle: React.CSSProperties = {
  fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
  color: "var(--ezy-red, #e55)",
  marginBottom: 12,
  lineHeight: 1.5,
};

const inlineCodeStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  backgroundColor: "var(--ezy-surface)",
  padding: "1px 5px",
  borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
  fontSize: "0.9em",
  color: "var(--ezy-text)",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
  color: "var(--ezy-text)",
  backgroundColor: "var(--ezy-surface)",
  border: "1px solid var(--ezy-border)",
  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
  outline: "none",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

function buttonStyle(primary: boolean, disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 14px",
    fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
    fontWeight: 600,
    color: primary ? (disabled ? "var(--ezy-text-muted)" : "#fff") : "var(--ezy-text)",
    backgroundColor: primary ? (disabled ? "var(--ezy-surface)" : "var(--ezy-accent)") : "var(--ezy-surface-raised)",
    border: primary ? (disabled ? "1px solid var(--ezy-border)" : "none") : "1px solid var(--ezy-border)",
    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    transition: "background-color 150ms ease",
    flexShrink: 0,
  };
}

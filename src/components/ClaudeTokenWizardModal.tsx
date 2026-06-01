import { useState, useEffect, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { useOverlayPublisher } from "../store/overlayRegionSlice";
import { getClaudeSetupTokenCommand } from "../lib/terminal-config";

interface ClaudeTokenWizardModalProps {
  /** Connection details for the server to run `claude setup-token` on. */
  server: { host: string; username: string; authMethod: string; sshKeyPath?: string };
  /** Called with the captured `sk-ant-oat…` token on success. */
  onToken: (token: string) => void;
  onClose: () => void;
}

type Phase = "connecting" | "authorize" | "exchanging" | "done" | "error";

// Tight: exact observed token format. Read from the byte stream, so no line-wrap truncation.
const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]+/;
// Loose: any https URL — we then prefer one that looks like an Anthropic/OAuth URL.
const URL_RE = /https?:\/\/[^\s'"]+/g;

const URL_TIMEOUT_MS = 30_000;
const TOKEN_TIMEOUT_MS = 60_000;

/** Strip terminal control sequences so regex matching sees plain text. */
function cleanOutput(s: string): string {
  return s
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "") // DCS (e.g. Warp version reply)
    .replace(/\x1b\][\s\S]*?(\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[@-Z\\-_]/g, "") // other single-char escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""); // stray control chars (keep \t \n \r)
}

export default function ClaudeTokenWizardModal({ server, onToken, onClose }: ClaudeTokenWizardModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  useOverlayPublisher("claude-token-wizard", overlayRef);

  const [phase, setPhase] = useState<Phase>("connecting");
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [rawOutput, setRawOutput] = useState("");
  const [showOutput, setShowOutput] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const ptyIdRef = useRef<number | null>(null);
  const bytesRef = useRef<number[]>([]);
  const urlCapturedRef = useRef(false);
  const phaseRef = useRef<Phase>("connecting");

  // Keep refs fresh for use inside the once-spawned PTY callbacks.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const serverRef = useRef(server);
  serverRef.current = server;

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const killPty = useCallback(() => {
    const id = ptyIdRef.current;
    if (id !== null) {
      invoke("pty_kill", { ptyId: id }).catch(() => {});
      ptyIdRef.current = null;
    }
  }, []);

  const fail = useCallback(
    (msg: string) => {
      if (phaseRef.current === "done" || phaseRef.current === "error") return;
      phaseRef.current = "error";
      setErrorMsg(msg);
      setPhase("error");
      killPty();
    },
    [killPty],
  );

  // Spawn `ssh … claude setup-token` once per attempt; re-runs on retry.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { command, args } = getClaudeSetupTokenCommand(serverRef.current);

        const onData = new Channel<number[]>();
        onData.onmessage = (bytes) => {
          for (let i = 0; i < bytes.length; i++) bytesRef.current.push(bytes[i]);
          const text = cleanOutput(new TextDecoder().decode(new Uint8Array(bytesRef.current)));
          setRawOutput(text);

          const tok = text.match(TOKEN_RE);
          if (tok && phaseRef.current !== "done" && phaseRef.current !== "error") {
            phaseRef.current = "done";
            setPhase("done");
            killPty();
            onTokenRef.current(tok[0]);
            return;
          }

          if (!urlCapturedRef.current) {
            const matches = text.match(URL_RE);
            const found = matches?.find((m) => /anthropic|claude|oauth/i.test(m));
            if (found) {
              urlCapturedRef.current = true;
              setUrl(found);
              if (phaseRef.current === "connecting") {
                phaseRef.current = "authorize";
                setPhase("authorize");
              }
            }
          }
        };

        const onExit = new Channel<number>();
        onExit.onmessage = () => {
          if (phaseRef.current !== "done" && phaseRef.current !== "error") {
            fail("The SSH session closed before a token was produced. Check the output below.");
          }
        };

        const id = await invoke<number>("pty_spawn", {
          command,
          args,
          cols: 80,
          rows: 24,
          cwd: null,
          env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
          onData,
          onExit,
        });
        if (cancelled) {
          invoke("pty_kill", { ptyId: id }).catch(() => {});
          return;
        }
        ptyIdRef.current = id;
      } catch (e) {
        if (!cancelled) fail(String(e));
      }
    })();

    return () => {
      cancelled = true;
      killPty();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  // Per-phase timeouts.
  useEffect(() => {
    if (phase === "connecting") {
      const t = setTimeout(
        () => fail("Timed out waiting for the authorization URL. Is the SSH key set up and `claude` installed on the server?"),
        URL_TIMEOUT_MS,
      );
      return () => clearTimeout(t);
    }
    if (phase === "exchanging") {
      const t = setTimeout(() => fail("Timed out waiting for the token after submitting the code."), TOKEN_TIMEOUT_MS);
      return () => clearTimeout(t);
    }
  }, [phase, fail]);

  // Escape closes (matches ConnectToGitHubModal).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const submitCode = useCallback(() => {
    const id = ptyIdRef.current;
    const trimmed = code.trim();
    if (id === null || !trimmed) return;
    invoke("pty_write", { ptyId: id, data: trimmed + "\r" }).catch(() => {});
    phaseRef.current = "exchanging";
    setPhase("exchanging");
  }, [code]);

  const retry = useCallback(() => {
    killPty();
    bytesRef.current = [];
    urlCapturedRef.current = false;
    setUrl("");
    setCode("");
    setRawOutput("");
    setErrorMsg("");
    phaseRef.current = "connecting";
    setPhase("connecting");
    setRetryNonce((n) => n + 1);
  }, [killPty]);

  const openUrl = useCallback(() => {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }, [url]);

  const copyUrl = useCallback(() => {
    if (!url) return;
    navigator.clipboard?.writeText(url).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [url]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        ref={overlayRef}
        style={{
          maxWidth: 480,
          width: "100%",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 10,
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
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>Set up Claude login token</span>
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
          {phase === "connecting" && (
            <div style={{ fontSize: 12, color: "var(--ezy-text-muted)", padding: "8px 0", lineHeight: 1.5 }}>
              Connecting to <strong style={{ color: "var(--ezy-text-secondary)" }}>{server.username}@{server.host}</strong> and
              starting <code style={inlineCodeStyle}>claude setup-token</code>…
            </div>
          )}

          {(phase === "authorize" || phase === "exchanging") && (
            <>
              <div style={{ fontSize: 13, color: "var(--ezy-text)", marginBottom: 6, fontWeight: 500 }}>
                Authorize in your browser
              </div>
              <div style={{ fontSize: 12, color: "var(--ezy-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
                Open this link, sign in and approve. Anthropic will show you a code — paste it below.
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  border: "1px solid var(--ezy-border)",
                  borderRadius: 6,
                  backgroundColor: "var(--ezy-surface)",
                  marginBottom: 14,
                }}
              >
                <span
                  onClick={openUrl}
                  title={url}
                  style={{
                    flex: 1,
                    fontSize: 12,
                    color: "var(--ezy-accent)",
                    cursor: "pointer",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    textDecoration: "underline",
                  }}
                >
                  {url}
                </span>
                <button onClick={copyUrl} style={smallBtnStyle}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>

              <FieldLabel>Authorization code</FieldLabel>
              <input
                type="text"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCode();
                }}
                placeholder="Paste the code from your browser"
                disabled={phase === "exchanging"}
                style={inputStyle}
              />

              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button
                  onClick={submitCode}
                  disabled={phase === "exchanging" || !code.trim()}
                  style={buttonStyle(true, phase === "exchanging" || !code.trim())}
                >
                  {phase === "exchanging" ? "Exchanging…" : "Submit code"}
                </button>
                <button onClick={onClose} style={buttonStyle(false, false)}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {phase === "done" && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ezy-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              <span style={{ fontSize: 13, color: "var(--ezy-text)" }}>
                Token captured and saved to this server. Remember to <strong>Save</strong> the server.
              </span>
            </div>
          )}

          {phase === "error" && (
            <>
              <div style={{ fontSize: 13, color: "var(--ezy-red, #e55)", marginBottom: 10, lineHeight: 1.5 }}>
                {errorMsg}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={retry} style={buttonStyle(true, false)}>
                  Retry
                </button>
                <button onClick={onClose} style={buttonStyle(false, false)}>
                  Close
                </button>
              </div>
            </>
          )}

          {/* Raw-output safety net — always available so the token can be copied manually. */}
          {rawOutput && (
            <div style={{ marginTop: 16 }}>
              <button
                onClick={() => setShowOutput((v) => !v)}
                style={{
                  fontSize: 11,
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
                    fontSize: 11,
                    lineHeight: 1.5,
                    color: "var(--ezy-text-secondary)",
                    backgroundColor: "var(--ezy-bg)",
                    border: "1px solid var(--ezy-border)",
                    borderRadius: 6,
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

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 6, fontWeight: 500 }}>{children}</div>
  );
}

const inlineCodeStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  backgroundColor: "var(--ezy-surface)",
  padding: "1px 5px",
  borderRadius: 3,
  fontSize: "0.9em",
  color: "var(--ezy-text)",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  color: "var(--ezy-text)",
  backgroundColor: "var(--ezy-surface)",
  border: "1px solid var(--ezy-border)",
  borderRadius: 6,
  outline: "none",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const smallBtnStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "4px 8px",
  borderRadius: 4,
  border: "1px solid var(--ezy-border)",
  backgroundColor: "var(--ezy-surface-raised)",
  color: "var(--ezy-text-secondary)",
  cursor: "pointer",
  fontFamily: "inherit",
  flexShrink: 0,
};

function buttonStyle(primary: boolean, disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 600,
    color: primary ? (disabled ? "var(--ezy-text-muted)" : "#fff") : "var(--ezy-text)",
    backgroundColor: primary ? (disabled ? "var(--ezy-surface)" : "var(--ezy-accent)") : "var(--ezy-surface-raised)",
    border: primary ? (disabled ? "1px solid var(--ezy-border)" : "none") : "1px solid var(--ezy-border)",
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    transition: "background-color 150ms ease",
    flexShrink: 0,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { useModalWhen } from "../store/modalCoordinationSlice";
import { MODAL_BACKDROP } from "../lib/modal-layout";
import {
  CLI_INSTALL_EVENT,
  type CliInstallRequest,
} from "../lib/cli-install-modal";
import {
  AI_CLI_LABEL,
  backendLabel,
  cliStatus,
  invalidateCliStatus,
} from "../lib/cli-availability";
import {
  EXIT_CANCELLED,
  cancelCliInstall,
  installCommands,
  refreshAfterInstall,
  startCliInstall,
} from "../lib/cli-install";
import { CliCommandRow } from "./CliMissingCard";

/**
 * Installs an AI CLI on a chosen backend, live.
 *
 * `npm install -g` and the Claude installer take tens of seconds and say
 * nothing useful until they are done. A dialog that only spun would be
 * indistinguishable from a hang, so the installer's own stdout and stderr
 * stream into the log as they arrive — that IS the progress indicator (the
 * pulse/ping animations this app bans would tell the user less, not more).
 *
 * On success the dialog does not just close. It becomes the next action: a
 * Launch button that starts the pane the user was trying to open in the first
 * place. Whoever opened the dialog decides what that means (see
 * `CliInstallRequest.onLaunch`).
 *
 * Mounted once in App, so `useModalWhen` — NOT `useModal`, which in an
 * always-mounted component registers a fullscreen modal forever and hides every
 * native pane permanently.
 */

type Phase = "confirm" | "running" | "done" | "failed";

/** Log lines kept in memory. npm's progress output is chatty; the tail is what
 *  matters and an unbounded array in a long install is just a leak. */
const MAX_LINES = 500;

export default function CliInstallModal() {
  const [req, setReq] = useState<CliInstallRequest | null>(null);
  const [phase, setPhase] = useState<Phase>("confirm");
  const [lines, setLines] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [exitCode, setExitCode] = useState<number | null>(null);
  /** Set when the install worked but the CLI still is not resolvable — the
   *  native-Windows PATH case, which needs a restart, not a retry. */
  const [needsRestart, setNeedsRestart] = useState(false);

  const installIdRef = useRef<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  /** Bumped on every close; a stream that outlives the dialog must not write
   *  into the next one. */
  const runRef = useRef(0);

  const server = useAppStore((s) =>
    req?.serverId ? s.servers.find((x) => x.id === req.serverId) : undefined,
  );

  const open = req !== null;
  useModalWhen("cli-install", open);

  const close = useCallback(() => {
    runRef.current++;
    const id = installIdRef.current;
    if (id != null) void cancelCliInstall(id);
    installIdRef.current = null;
    setReq(null);
    setPhase("confirm");
    setLines([]);
    setElapsed(0);
    setExitCode(null);
    setNeedsRestart(false);
  }, []);

  useEffect(() => {
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<CliInstallRequest>).detail;
      runRef.current++;
      installIdRef.current = null;
      setPhase("confirm");
      setLines([]);
      setElapsed(0);
      setExitCode(null);
      setNeedsRestart(false);
      setReq(detail);
    };
    window.addEventListener(CLI_INSTALL_EVENT, onRequest);
    return () => window.removeEventListener(CLI_INSTALL_EVENT, onRequest);
  }, []);

  // Elapsed time. A number that moves is honest about a long install in a way
  // a static "Installing…" is not.
  useEffect(() => {
    if (phase !== "running") return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Follow the tail, but only while the user has not scrolled up to read.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const start = useCallback(async () => {
    if (!req) return;
    const run = ++runRef.current;
    setPhase("running");
    setLines([]);
    setExitCode(null);
    setNeedsRestart(false);
    try {
      const { id } = await startCliInstall({
        cli: req.cli,
        backend: req.backend,
        server,
        onLine: (line) => {
          if (runRef.current !== run) return;
          setLines((prev) => (prev.length >= MAX_LINES ? [...prev.slice(1), line] : [...prev, line]));
        },
        onExit: (code) => {
          if (runRef.current !== run) return;
          installIdRef.current = null;
          setExitCode(code);
          if (code !== 0) {
            setPhase("failed");
            return;
          }
          // Exit 0 is the installer's opinion. Whether the CLI can now be
          // FOUND is a separate question, and on native Windows the honest
          // answer is "not until MADE restarts": the installer updates the
          // user's PATH in the registry, but this process inherited its
          // environment at launch.
          void (async () => {
            await refreshAfterInstall(req.cli, req.backend, server);
            invalidateCliStatus(req.cli, req.backend, server);
            const status = await cliStatus(req.cli, req.backend, server);
            if (runRef.current !== run) return;
            setNeedsRestart(status !== "present");
            setPhase("done");
          })();
        },
      });
      if (runRef.current !== run) {
        void cancelCliInstall(id);
        return;
      }
      installIdRef.current = id;
    } catch (err) {
      if (runRef.current !== run) return;
      setLines((prev) => [...prev, String(err)]);
      setExitCode(-1);
      setPhase("failed");
    }
  }, [req, server]);

  const cancel = useCallback(() => {
    const id = installIdRef.current;
    if (id != null) void cancelCliInstall(id);
  }, []);

  const launch = useCallback(() => {
    const go = req?.onLaunch;
    close();
    go?.();
  }, [req, close]);

  if (!req) return null;

  const label = AI_CLI_LABEL[req.cli];
  const where = backendLabel(req.backend, server);
  const commands = installCommands(req.cli, req.backend);
  const cancelled = exitCode === EXIT_CANCELLED;

  return (
    <div
      style={{ ...MODAL_BACKDROP, zIndex: 300, background: "rgba(0,0,0,0.55)" }}
      onClick={phase === "running" ? undefined : close}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && phase !== "running") {
            e.stopPropagation();
            close();
          }
        }}
        style={{
          width: 520,
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
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 14px)", fontWeight: 600, flex: 1 }}>
              {phase === "done"
                ? `${label} installed`
                : phase === "failed"
                  ? cancelled
                    ? "Install stopped"
                    : "Install failed"
                  : `Install ${label}`}
            </div>
            {phase === "running" && (
              <div
                style={{
                  fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                  color: "var(--ezy-text-muted)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {formatElapsed(elapsed)}
              </div>
            )}
          </div>

          <div
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              marginTop: 6,
              lineHeight: 1.45,
              color: "var(--ezy-text-muted)",
            }}
          >
            {phase === "done"
              ? needsRestart
                ? `Installed on ${where}. Restart MADE so it picks up the new PATH.`
                : `Ready on ${where}.`
              : phase === "failed"
                ? cancelled
                  ? `Nothing was changed on ${where} by MADE after the stop.`
                  : `The installer exited ${exitCode}. Run the command yourself to see more.`
                : `Runs on ${where}. Nothing else on that machine is touched.`}
          </div>

          <div style={{ marginTop: 12 }}>
            <CliCommandRow command={commands[0]} />
            {/* The second rung is only worth naming once it is the user's job
                to run something — before that it is an implementation detail
                of a button they have not pressed yet. */}
            {phase === "failed" && !cancelled && commands.length > 1 && (
              <div style={{ marginTop: 6 }}>
                <CliCommandRow command={commands[1]} />
              </div>
            )}
          </div>

          {(phase === "running" || lines.length > 0) && (
            <div
              ref={logRef}
              style={{
                marginTop: 12,
                height: 190,
                overflowY: "auto",
                padding: "8px 10px",
                border: "1px solid var(--ezy-border)",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                background: "var(--ezy-bg, #0d1117)",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                lineHeight: 1.55,
                color: "var(--ezy-text-secondary)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {lines.length === 0 ? (
                <span style={{ color: "var(--ezy-text-muted)" }}>Starting…</span>
              ) : (
                lines.map((line, i) => <div key={i}>{line}</div>)
              )}
            </div>
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
          {phase === "running" ? (
            <button onClick={cancel} style={secondaryButton}>
              Stop
            </button>
          ) : (
            <button onClick={close} style={secondaryButton}>
              {phase === "done" ? "Done" : "Close"}
            </button>
          )}
          {phase === "confirm" && (
            <button onClick={() => void start()} style={primaryButton}>
              Install
            </button>
          )}
          {phase === "failed" && (
            <button onClick={() => void start()} style={primaryButton}>
              Try again
            </button>
          )}
          {phase === "done" && req.onLaunch && !needsRestart && (
            <button onClick={launch} style={primaryButton}>
              {req.launchLabel ?? "Launch"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const primaryButton: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
  fontWeight: 600,
  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
  border: "none",
  cursor: "pointer",
  backgroundColor: "var(--ezy-accent)",
  color: "#fff",
  fontFamily: "inherit",
};

const secondaryButton: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
  border: "1px solid var(--ezy-border)",
  cursor: "pointer",
  background: "transparent",
  color: "var(--ezy-text)",
  fontFamily: "inherit",
};

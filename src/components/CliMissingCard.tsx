import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteServer, TerminalBackend } from "../types";
import { AI_CLI_LABEL, backendLabel, type AiCli } from "../lib/cli-availability";
import { installCommands } from "../lib/cli-install";
import { requestCliInstall } from "../lib/cli-install-modal";
import { checkServerReachable } from "../lib/ssh-reachability";

/**
 * What a pane shows instead of spawning a CLI its backend does not have.
 *
 * The pane used to spawn anyway and sit on `zsh:1: command not found: codex`,
 * which reads as "MADE is broken" rather than "this machine has no Codex". So
 * the card answers the three questions that error never did: which CLI, WHICH
 * MACHINE, and what fixes it.
 *
 * The exact command is on screen before Install is pressed. That is not
 * decoration — it is what makes a one-click `curl … | bash` a decision the user
 * made rather than one MADE made for them.
 */

interface Props {
  cli: AiCli;
  backend: TerminalBackend;
  server?: RemoteServer | null;
  /** Re-run the availability check (the user may have installed it by hand). */
  onRecheck: () => void;
  /** Spawn the pane regardless — the check can be wrong about an exotic PATH. */
  onStartAnyway: () => void;
  /** Spawn the pane once the install succeeds. */
  onInstalled: () => void;
}

/** A command with a Copy button. Shared with the install dialog. */
export function CliCommandRow({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 9px",
        border: "1px solid var(--ezy-border)",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
        backgroundColor: "var(--ezy-surface)",
        minWidth: 0,
      }}
    >
      <span
        style={{
          flex: 1,
          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
          color: "var(--ezy-text)",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          overflowX: "auto",
          whiteSpace: "nowrap",
        }}
      >
        {command}
      </span>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(command).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        style={{
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          padding: "3px 8px",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
          border: "1px solid var(--ezy-border)",
          backgroundColor: "var(--ezy-surface-raised)",
          color: copied ? "var(--ezy-accent)" : "var(--ezy-text-secondary)",
          cursor: "pointer",
          fontFamily: "inherit",
          flexShrink: 0,
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export default function CliMissingCard({
  cli,
  backend,
  server,
  onRecheck,
  onStartAnyway,
  onInstalled,
}: Props) {
  const where = backendLabel(backend, server);
  // Only the first rung is shown. The npm fallback is Claude's recovery path,
  // not a second thing the user is being asked to approve, and printing both
  // would make the card read as "run these two commands".
  const command = installCommands(cli, backend)[0];
  const preposition = backend === "wsl" ? "in" : "on";

  const install = useCallback(() => {
    requestCliInstall({
      cli,
      backend,
      serverId: server?.id,
      onLaunch: onInstalled,
      launchLabel: `Start ${AI_CLI_LABEL[cli].split(" ")[0]}`,
    });
  }, [cli, backend, server?.id, onInstalled]);

  return (
    <div
      data-cli-missing-card
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        overflow: "auto",
        fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
        color: "var(--ezy-text)",
      }}
    >
      <div style={{ width: 420, maxWidth: "100%" }}>
        <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 14px)", fontWeight: 600 }}>
          {AI_CLI_LABEL[cli]} isn&rsquo;t installed {preposition} {where}
        </div>
        <div
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            marginTop: 6,
            marginBottom: 14,
            lineHeight: 1.5,
            color: "var(--ezy-text-muted)",
          }}
        >
          This pane would open on <code style={codeStyle}>command not found</code>. MADE can
          install it for you and start the pane when it&rsquo;s done.
        </div>

        <CliCommandRow command={command} />

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14 }}>
          <button onClick={install} style={primaryButton}>
            Install
          </button>
          <button onClick={onRecheck} style={secondaryButton}>
            Check again
          </button>
          <button
            onClick={onStartAnyway}
            style={{ ...secondaryButton, border: "none", color: "var(--ezy-text-muted)" }}
          >
            Open anyway
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What a remote pane shows when the server itself does not answer.
 *
 * Two situations land here, and they need different escape hatches:
 *
 * - `variant="preflight"`: the CLI looked missing in the persisted probe, but
 *   the server is unreachable — so nothing can be verified or installed.
 *   "Try again" re-tests the connection and only re-runs the CLI check once
 *   the server answers; "Open anyway" remains the check-might-be-wrong hatch.
 *
 * - `variant="spawn"`: ssh died before ever connecting (the pane's only
 *   output was the client error shown on the card). "Try again" respawns
 *   immediately — no probe gate, because password-auth servers can never pass
 *   the BatchMode probe yet reconnect fine interactively.
 */
export function RemoteOfflineCard({
  server,
  cli,
  detail,
  variant,
  onRetry,
  onStartAnyway,
}: {
  server: RemoteServer | null;
  /** Names what cannot be checked/installed (preflight variant only). */
  cli?: AiCli;
  /** The ssh client's own error line (spawn variant only). */
  detail?: string | null;
  variant: "preflight" | "spawn";
  onRetry: () => void;
  onStartAnyway?: () => void;
}) {
  const name = server?.name || server?.host || "this server";
  const address = server ? `${server.username}@${server.host}` : null;
  const [busy, setBusy] = useState(false);
  const [stillDown, setStillDown] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const retry = useCallback(async () => {
    if (variant === "spawn" || !server) {
      onRetry();
      return;
    }
    // Preflight: re-test the connection here so the button can report an
    // honest verdict — handing straight off to the CLI re-check would leave
    // the card frozen for the probe's whole timeout with no feedback.
    setBusy(true);
    setStillDown(false);
    const reachable = await checkServerReachable(server);
    if (!aliveRef.current) return;
    setBusy(false);
    if (reachable === false) {
      setStillDown(true);
      return;
    }
    onRetry();
  }, [variant, server, onRetry]);

  return (
    <div
      data-remote-offline-card
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        overflow: "auto",
        fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
        color: "var(--ezy-text)",
      }}
    >
      <div style={{ width: 420, maxWidth: "100%" }}>
        <div style={{ fontSize: "calc(var(--ezy-font-scale, 1) * 14px)", fontWeight: 600 }}>
          No connection to {name}
        </div>
        <div
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            marginTop: 6,
            marginBottom: 14,
            lineHeight: 1.5,
            color: "var(--ezy-text-muted)",
          }}
        >
          {variant === "preflight" ? (
            <>
              MADE can&rsquo;t reach {address ?? "the server"}
              {cli ? (
                <>
                  , so it can&rsquo;t check for {AI_CLI_LABEL[cli]} or install it
                </>
              ) : null}
              . The pane will open once the connection is back.
            </>
          ) : (
            <>The SSH connection failed before the pane could start.</>
          )}
        </div>

        {variant === "spawn" && detail ? <CliCommandRow command={detail} /> : null}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: variant === "spawn" && detail ? 14 : 0,
          }}
        >
          <button onClick={() => void retry()} disabled={busy} style={{ ...primaryButton, opacity: busy ? 0.6 : 1 }}>
            {busy ? "Checking…" : "Try again"}
          </button>
          {onStartAnyway && (
            <button
              onClick={onStartAnyway}
              style={{ ...secondaryButton, border: "none", color: "var(--ezy-text-muted)" }}
            >
              Open anyway
            </button>
          )}
          {stillDown && !busy && (
            <span
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                color: "var(--ezy-text-muted)",
              }}
            >
              Still unreachable.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const codeStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  backgroundColor: "var(--ezy-surface)",
  padding: "1px 5px",
  borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
  fontSize: "0.92em",
  color: "var(--ezy-text)",
};

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
  padding: "6px 12px",
  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
  border: "1px solid var(--ezy-border)",
  cursor: "pointer",
  background: "transparent",
  color: "var(--ezy-text)",
  fontFamily: "inherit",
};

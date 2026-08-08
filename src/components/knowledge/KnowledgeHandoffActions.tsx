import { useEffect, useState } from "react";
import { useKnowledgeStore } from "../../store/knowledgeStore";
import { canonicalProjectKey } from "../../lib/knowledge/keys";
import * as api from "../../lib/knowledge/api";

/**
 * Passing work from one agent to another.
 *
 * This is the pair of actions that makes shared memory worth having before MCP
 * exists: finish in a Claude pane, create a handoff, then pick it up in a Codex
 * pane without re-explaining anything.
 *
 * The actions themselves live in KnowledgeSidebar, because the context menu
 * calls the same two through the surface registry and a second copy would be a
 * second thing to keep correct. What this component adds is the one fact
 * neither the sidebar nor the menu tracks: whether a handoff exists at all, so
 * "Continue" can say "No handoffs yet" instead of failing when pressed.
 */
interface Props {
  workingDir: string;
  onCreateHandoff: () => void;
  onContinueHandoff: () => void;
  /** Non-null disables the action and becomes its tooltip. */
  createBlocked: string | null;
  /** Reasons the caller knows about (read-only, no agent pane). */
  continueBlocked: string | null;
  busy: boolean;
}

function ActionButton({
  label,
  onClick,
  blocked,
  busy,
}: {
  label: string;
  onClick: () => void;
  blocked: string | null;
  busy: boolean;
}) {
  const disabled = !!blocked || busy;
  return (
    <button
      onClick={() => {
        if (!disabled) onClick();
      }}
      aria-disabled={disabled}
      data-tooltip={blocked ?? undefined}
      style={{
        width: "100%",
        textAlign: "left",
        padding: "5px 8px",
        fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
        fontFamily: "var(--ezy-font-ui)",
        color: disabled ? "var(--ezy-text-muted)" : "var(--ezy-text-secondary)",
        backgroundColor: "transparent",
        border: "1px solid var(--ezy-border-subtle)",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.65 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {label}
    </button>
  );
}

export default function KnowledgeHandoffActions({
  workingDir,
  onCreateHandoff,
  onContinueHandoff,
  createBlocked,
  continueBlocked,
  busy,
}: Props) {
  const key = canonicalProjectKey(workingDir);
  const project = useKnowledgeStore((s) => s.projects[key]);
  const usable = project?.status === "ready" || project?.status === "readonly";
  const revision = project?.revision ?? 0;

  /** undefined = not probed yet, null = none exist. */
  const [hasHandoff, setHasHandoff] = useState<boolean | undefined>(undefined);

  // Re-read on every revision change, which is exactly when a handoff could
  // have appeared — including one an agent wrote in another pane.
  useEffect(() => {
    if (!usable) {
      setHasHandoff(undefined);
      return;
    }
    let cancelled = false;
    api
      .latestHandoff(workingDir)
      .then((h) => {
        if (!cancelled) setHasHandoff(!!h);
      })
      .catch(() => {
        // A failed probe must not invent "no handoffs" — leave the button
        // enabled and let the action report the real error if it fails.
        if (!cancelled) setHasHandoff(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [workingDir, usable, revision]);

  const continueReason = continueBlocked ?? (hasHandoff === false ? "No handoffs yet" : null);

  return (
    <div
      style={{
        borderTop: "1px solid var(--ezy-border-subtle)",
        padding: 6,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        flexShrink: 0,
      }}
    >
      <ActionButton
        label="Create handoff"
        onClick={onCreateHandoff}
        blocked={createBlocked}
        busy={busy}
      />
      <ActionButton
        label="Continue from latest handoff"
        onClick={onContinueHandoff}
        blocked={continueReason}
        busy={busy}
      />
    </div>
  );
}

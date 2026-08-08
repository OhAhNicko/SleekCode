import { useState } from "react";
import LoadingDots from "../LoadingDots";
import { projectLeafName, MEMORY_DIR_NAME } from "../../lib/knowledge/keys";

/**
 * First run for a project that has no shared memory yet.
 *
 * MADE has never written into a user's project unasked, and this feature is
 * not the one to start: creating `.project-memory/` is a visible, committable
 * change to their repository. So the panel says exactly what will be created
 * and where, and nothing happens until the button is pressed.
 *
 * "Not now" is a real answer, not a delay — it collapses this to one quiet
 * line for that project and stays collapsed across restarts.
 */
interface Props {
  projectPath: string;
  /** True once the user chose "Not now" for this project. */
  dismissed: boolean;
  /** OFF means the user turned off auto-attach: offer Connect, not Initialize. */
  autoAttach: boolean;
  onInitialize: () => Promise<void>;
  onConnect: () => void;
  onDismiss: () => void;
}

export default function KnowledgeInitPanel({
  projectPath,
  dismissed,
  autoAttach,
  onInitialize,
  onConnect,
  onDismiss,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectName = projectLeafName(projectPath) || projectPath;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await onInitialize();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (dismissed && !busy) {
    return (
      <div
        style={{
          padding: "10px",
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          color: "var(--ezy-text-muted)",
        }}
      >
        Knowledge not initialized ·{" "}
        <span
          role="button"
          onClick={() => void start()}
          style={{ color: "var(--ezy-accent)", cursor: "pointer" }}
        >
          Initialize
        </span>
      </div>
    );
  }

  return (
    <div style={{ padding: "14px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
          color: "var(--ezy-text)",
          lineHeight: 1.5,
        }}
      >
        NexusMind keeps shared project memory your agents can read and write.
      </div>
      <div
        style={{
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          color: "var(--ezy-text-muted)",
          lineHeight: 1.5,
        }}
      >
        Creates <span style={{ color: "var(--ezy-text-secondary)" }}>{MEMORY_DIR_NAME}/</span> in{" "}
        <span style={{ color: "var(--ezy-text-secondary)" }}>{projectName}</span> with 7 core memory
        files. Nothing else in the project is touched.
      </div>

      {!autoAttach && (
        <div
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-text-muted)",
            lineHeight: 1.5,
          }}
        >
          Attaching on project open is off in Settings, so this project is not connected yet.
        </div>
      )}

      {error && (
        <div
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-red)",
            lineHeight: 1.4,
            wordBreak: "break-word",
          }}
        >
          {error}
        </div>
      )}

      <button
        onClick={() => void start()}
        disabled={busy}
        style={{
          padding: "6px 10px",
          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
          fontFamily: "var(--ezy-font-ui)",
          color: "var(--ezy-on-accent)",
          backgroundColor: "var(--ezy-accent)",
          border: "none",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.7 : 1,
        }}
      >
        {busy ? <LoadingDots>Initializing</LoadingDots> : "Initialize NexusMind"}
      </button>

      {!autoAttach && (
        <span
          role="button"
          onClick={onConnect}
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-accent)",
            cursor: "pointer",
            alignSelf: "flex-start",
          }}
        >
          Connect without creating files
        </span>
      )}

      {!dismissed && (
        <span
          role="button"
          onClick={onDismiss}
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-text-muted)",
            cursor: "pointer",
            alignSelf: "flex-start",
          }}
        >
          Not now
        </span>
      )}
    </div>
  );
}

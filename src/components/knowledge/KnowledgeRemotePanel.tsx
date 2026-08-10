import { useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import LoadingDots from "../LoadingDots";
import { useAppStore } from "../../store";
import { projectLeafName } from "../../lib/knowledge/keys";
import {
  forgetRevalidation,
  probeMirror,
  proposeLocalTwins,
  saveProvenMirror,
  type MirrorProbeResult,
} from "../../lib/knowledge/remote-mirror";

/**
 * SSH project tabs — the folder is on the server, so where is it here?
 *
 * The tab stays visible on remote projects on purpose: hiding the feature
 * would make it look like it does not exist rather than like it does not apply
 * here yet. What changed is that "does not apply" is no longer the only answer.
 * A very common setup shares the project FROM this machine and mounts it on the
 * server, and then the database and the watcher are already in the right place
 * — only the path needs linking.
 *
 * So the panel proposes a local folder, proves it, and gets out of the way. It
 * never assumes: a wrong link would attach this project's memory to a different
 * project, so the button runs a real round-trip through the share and the panel
 * reports which step failed rather than "could not link".
 */
interface Props {
  /** The tab's working directory — a path on the server. */
  tabDir: string;
  serverId?: string;
  /** Local path implied by a link already proven on a sibling folder. */
  proposedPath?: string;
  /** A link that was proven once and no longer holds — the share moved. */
  stale?: boolean;
  /** Clear the parent's stale flag once a fresh check passes. */
  onRelinked?: () => void;
}

/** Muted 11px body line — the panel's explanation register. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
        color: "var(--ezy-text-muted)",
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

/** A path, inline. Same emphasis the init panel gives `.project-memory/`. */
function PathText({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "var(--ezy-text-secondary)", wordBreak: "break-all" }}>{children}</span>;
}

export default function KnowledgeRemotePanel({
  tabDir,
  serverId,
  proposedPath,
  stale,
  onRelinked,
}: Props) {
  const server = useAppStore((s) => s.servers.find((x) => x.id === serverId));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MirrorProbeResult | null>(null);
  /** A folder the user picked by hand, which outranks anything guessed. */
  const [picked, setPicked] = useState<string | null>(null);

  // Leaf-name matches against local projects MADE already knows. Cheap enough
  // to compute on render; it is a filter over at most 15 recent projects.
  const guessed = useMemo(() => proposeLocalTwins(tabDir), [tabDir]);
  const candidate = picked ?? proposedPath ?? guessed[0] ?? null;

  const projectName = projectLeafName(tabDir) || tabDir;
  const serverName = server?.name || server?.host || "the server";

  const pick = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: `Local folder for ${projectName}`,
    });
    if (selected && typeof selected === "string") {
      setPicked(selected);
      setResult(null);
    }
  };

  const link = async () => {
    if (!server || !serverId || !candidate) return;
    setBusy(true);
    setResult(null);
    try {
      const outcome = await probeMirror(server, tabDir, candidate);
      setResult(outcome);
      if (outcome.ok) {
        // Saving is what makes the sidebar re-render into the real workspace:
        // the store update re-runs `resolveMirror` in the parent. The cached
        // verdict has to go first, or a re-link would keep reading the stale
        // "no" this panel was shown for.
        forgetRevalidation(serverId, tabDir);
        saveProvenMirror(serverId, tabDir, candidate);
        onRelinked?.();
      }
    } catch (e) {
      setResult({ ok: false, detail: String(e) });
    } finally {
      setBusy(false);
    }
  };

  // No server record: nothing to link against, and no action that would help.
  if (!server) {
    return (
      <div style={{ padding: "14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            color: "var(--ezy-text)",
            lineHeight: 1.5,
          }}
        >
          This project's server is no longer in Settings.
        </div>
        <Note>Add it back under Servers to use shared memory here.</Note>
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
        {stale
          ? `${serverName} can no longer reach ${projectName} through the linked folder.`
          : `${projectName} runs on ${serverName}. Shared memory lives on this machine.`}
      </div>

      <Note>
        {stale
          ? `The folder is still here, but ${serverName} does not see the same one any more — usually an unmounted share. Memory is untouched; check the folder again to reconnect.`
          : `NexusMind is a database plus a watched folder here, not on the server. If ${serverName} reaches this project through a folder shared from this machine, both are already in the right place — they just need linking.`}
      </Note>

      {candidate ? (
        <Note>
          Local folder: <PathText>{candidate}</PathText>
        </Note>
      ) : (
        <Note>
          No local folder matches <PathText>{projectName}</PathText>. Pick the one {serverName} is
          {" "}mounting.
        </Note>
      )}

      {/* No success state: a passing check saves the link, which re-resolves the
          tab and replaces this whole panel with the workspace. */}
      {result && !result.ok && (
        <div
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-red)",
            lineHeight: 1.4,
            wordBreak: "break-word",
          }}
        >
          {result.detail}
        </div>
      )}

      {candidate && (
        <button
          onClick={() => void link()}
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
          {busy ? <LoadingDots>Checking the folder</LoadingDots> : "Check and link folder"}
        </button>
      )}

      <span
        role="button"
        onClick={() => void pick()}
        style={{
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          color: "var(--ezy-accent)",
          cursor: "pointer",
          alignSelf: "flex-start",
        }}
      >
        {candidate ? "Pick a different folder…" : "Pick the local folder…"}
      </span>

      <Note>
        Checking writes one small file into the folder and reads it back from {serverName}, then
        {" "}removes it.
      </Note>
    </div>
  );
}

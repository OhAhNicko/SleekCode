import { useCallback, useEffect, useMemo, useState } from "react";
import LoadingDots from "../LoadingDots";
import { MODAL_BACKDROP, MODAL_MAX_HEIGHT } from "../../lib/modal-layout";
import { useModalWhen } from "../../store/modalCoordinationSlice";
import { useKnowledgeStore } from "../../store/knowledgeStore";
import * as api from "../../lib/knowledge/api";
import { relativeTime } from "../../lib/screenshots";
import {
  actorColor,
  actorLabel,
  type KnowledgeConflict,
  type KnowledgeConflictDetail,
  type KnowledgeConflictResolution,
} from "../../lib/knowledge/types";

/**
 * Two writers changed the same document from the same base.
 *
 * The one thing this dialog must never do is pick for the user. Both texts are
 * shown in full, side by side in time (whose, when), and whichever side loses
 * survives in the document's revision history — nothing here deletes anything.
 *
 * Panels are 12px in the normal UI font, not a monospace face: these are prose
 * documents, and small monospace is the single most common way to make a wall
 * of text unreadable.
 */

type Tab = "yours" | "current" | "merged";

/**
 * UI wording → service resolution value.
 *
 * The service names the sides from its OWN position: `mine` is the revision it
 * already holds (what the sidebar calls "current"), `theirs` is the incoming
 * write it refused (what the user recognises as "yours" — the edit they made
 * that did not land). Getting this backwards would discard the wrong text, so
 * it is written down once, here, and nowhere else.
 */
const RESOLUTION_FOR: Record<Tab, KnowledgeConflictResolution> = {
  yours: "theirs",
  current: "mine",
  merged: "merged",
};

function Segmented({
  tab,
  setTab,
  mergedReason,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  mergedReason: string | null;
}) {
  const options: { id: Tab; label: string; blocked: string | null }[] = [
    { id: "yours", label: "Your version", blocked: null },
    { id: "current", label: "Current version", blocked: null },
    { id: "merged", label: "Merged preview", blocked: mergedReason },
  ];
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid var(--ezy-border)",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
        overflow: "hidden",
      }}
    >
      {options.map((opt, i) => {
        const active = tab === opt.id;
        return (
          <button
            key={opt.id}
            onClick={() => {
              if (!opt.blocked) setTab(opt.id);
            }}
            aria-disabled={!!opt.blocked}
            data-tooltip={opt.blocked ?? undefined}
            style={{
              padding: "4px 12px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              fontFamily: "var(--ezy-font-ui)",
              color: active ? "var(--ezy-on-accent)" : "var(--ezy-text-secondary)",
              backgroundColor: active ? "var(--ezy-accent)" : "transparent",
              border: "none",
              borderLeft: i === 0 ? "none" : "1px solid var(--ezy-border)",
              cursor: opt.blocked ? "default" : "pointer",
              opacity: opt.blocked ? 0.5 : 1,
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  blocked,
  primary,
  busy,
}: {
  label: string;
  onClick: () => void;
  blocked: string | null;
  primary?: boolean;
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
        padding: "6px 14px",
        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
        fontFamily: "var(--ezy-font-ui)",
        color: primary ? "var(--ezy-on-accent)" : "var(--ezy-text-secondary)",
        backgroundColor: primary ? "var(--ezy-accent)" : "transparent",
        border: primary ? "none" : "1px solid var(--ezy-border)",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}

export default function KnowledgeConflictModal() {
  const modal = useKnowledgeStore((s) => s.openModal);
  const closeModal = useKnowledgeStore((s) => s.closeModal);
  const invalidate = useKnowledgeStore((s) => s.invalidateAfterOwnWrite);
  const open = modal?.kind === "conflict";
  const projectKey = open ? modal.projectKey : "";
  const project = useKnowledgeStore((s) => (projectKey ? s.projects[projectKey] : undefined));

  useModalWhen("knowledge-conflict", open);

  const conflicts: KnowledgeConflict[] = useMemo(() => project?.conflicts ?? [], [project?.conflicts]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeConflictDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("yours");
  const [busy, setBusy] = useState(false);
  /**
   * The conflict whose resolve was refused because the note had moved.
   *
   * Held as an ID rather than a boolean so the notice belongs to the record it
   * describes: it survives the store refresh that follows the change (which
   * re-runs the load effect for the same conflict) and disappears on its own
   * when the user switches to a different one.
   *
   * Not folded into `loadError`, because this is not a failure — the conflict
   * is still open, the panels now show current text, and the next attempt is
   * guarded by the new head. Calling it an error would report a malfunction
   * when what happened is that the user was stopped from deciding about text
   * they were no longer looking at.
   */
  const [staleFor, setStaleFor] = useState<string | null>(null);

  // Which conflict is on screen: the one that was clicked, else the first open
  // one. Resolving the last one closes the dialog rather than leaving an empty
  // shell behind.
  const current = useMemo(() => {
    if (conflicts.length === 0) return undefined;
    const wanted = activeId ?? (open ? modal.conflictId : undefined);
    return conflicts.find((c) => c.id === wanted) ?? conflicts[0];
  }, [conflicts, activeId, open, modal]);

  useEffect(() => {
    if (!open) {
      setActiveId(null);
      setDetail(null);
      setLoadError(null);
      setStaleFor(null);
      setTab("yours");
    }
  }, [open]);

  useEffect(() => {
    if (!open || !current || !project) {
      setDetail(null);
      return;
    }
    // The service may inline both texts on the list row; when it does the
    // dialog opens with no round-trip at all.
    if (typeof current.yours === "string" && typeof current.current === "string") {
      setDetail({ ...current, yours: current.yours, current: current.current });
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
    api
      .getConflict(project.path, current.id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(api.knowledgeErrorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, current, project]);

  const resolve = useCallback(
    (choice: Tab) => {
      if (!project || !current) return;
      const conflictId = current.id;
      setBusy(true);
      void api
        .resolveConflict(
          project.path,
          conflictId,
          RESOLUTION_FOR[choice],
          choice === "merged" ? detail?.merged : undefined,
          // The head this decision was made against. The service refuses if the
          // note has moved since, rather than committing a judgement about text
          // the user was no longer looking at.
          detail?.headRevision,
        )
        .then((result) => {
          if (result.status === "stale") {
            // Refused, and rightly so. Stay exactly where we are — same
            // conflict, same tab — but repaint what changed underneath and
            // re-arm the guard with the new head, so a second click works.
            setStaleFor(conflictId);
            setDetail((prev) =>
              prev
                ? {
                    ...prev,
                    current: result.current ?? prev.current,
                    // Drop a merge preview the service did not re-issue: it was
                    // computed against the old head, and offering it would be
                    // the exact stale commit this guard exists to prevent.
                    merged: result.merged,
                    headRevision: result.headRevision ?? prev.headRevision,
                  }
                : prev,
            );
            return;
          }
          invalidate(project.path);
          const remaining = conflicts.filter((c) => c.id !== conflictId);
          if (remaining.length === 0) closeModal();
          else setActiveId(remaining[0].id);
        })
        .catch((e) => setLoadError(api.knowledgeErrorText(e)))
        .finally(() => setBusy(false));
    },
    [project, current, detail, conflicts, invalidate, closeModal],
  );

  if (!open) return null;

  /** The notice belongs to one conflict; switching away retires it. */
  const stale = !!staleFor && staleFor === current?.id;

  const mergedReason = detail?.merged
    ? null
    : detail
      ? stale
        ? // Distinct from the overlap case on purpose: the edits may merge
          // perfectly well: what is missing is a merge against the CURRENT text.
          "No merge preview for the updated version — pick a side instead"
        : "No clean automatic merge — the edits overlap"
      : "Loading…";

  const body =
    tab === "yours" ? detail?.yours : tab === "current" ? detail?.current : detail?.merged;

  return (
    <div
      style={{ ...MODAL_BACKDROP, backgroundColor: "rgba(0,0,0,0.6)", zIndex: 250 }}
      onClick={closeModal}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "calc(100% - 64px)",
          maxWidth: 900,
          maxHeight: MODAL_MAX_HEIGHT,
          display: "flex",
          flexDirection: "column",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 10px)",
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--ezy-border)",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
              color: "var(--ezy-text-muted)",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            Conflicting edits
          </div>
          <div
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 15px)",
              color: "var(--ezy-text)",
              fontWeight: 600,
              marginTop: 2,
            }}
          >
            {current?.title ?? "No open conflicts"}
          </div>
          {current && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 10,
                marginTop: 6,
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                color: "var(--ezy-text-muted)",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    backgroundColor: actorColor(current.yoursActor),
                  }}
                />
                Yours: {actorLabel(current.yoursActor)} · {relativeTime(current.createdAt)}
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    backgroundColor: actorColor(current.currentActor),
                  }}
                />
                Current: {actorLabel(current.currentActor)}
              </span>
              <span>Nothing is deleted — the version you do not keep stays in history.</span>
            </div>
          )}
        </div>

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {conflicts.length > 1 && (
            <div
              style={{
                width: 180,
                flexShrink: 0,
                borderRight: "1px solid var(--ezy-border)",
                overflowY: "auto",
              }}
            >
              {conflicts.map((c) => (
                <div
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  style={{
                    padding: "8px 10px",
                    fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                    color: c.id === current?.id ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
                    backgroundColor: c.id === current?.id ? "var(--ezy-surface)" : "transparent",
                    cursor: "pointer",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.title}
                </div>
              ))}
            </div>
          )}

          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "10px 18px 8px", flexShrink: 0 }}>
              <Segmented tab={tab} setTab={setTab} mergedReason={mergedReason} />
            </div>
            {stale && (
              <div
                style={{
                  margin: "0 18px 8px",
                  padding: "6px 10px",
                  border: "1px solid var(--ezy-border)",
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                  backgroundColor: "var(--ezy-surface)",
                  fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                  color: "var(--ezy-text-secondary)",
                  flexShrink: 0,
                }}
              >
                The note changed while you were deciding — showing the updated version.
              </div>
            )}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflow: "auto",
                margin: "0 18px 12px",
                padding: 12,
                backgroundColor: "var(--ezy-bg)",
                border: "1px solid var(--ezy-border-subtle)",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                lineHeight: 1.55,
                color: "var(--ezy-text-secondary)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {loadError
                ? `Could not load this conflict: ${loadError}`
                : body !== undefined && body !== null
                  ? body
                  : <LoadingDots />}
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 18px",
            borderTop: "1px solid var(--ezy-border)",
            flexShrink: 0,
          }}
        >
          <ActionButton label="Close" onClick={closeModal} blocked={null} busy={false} />
          <div style={{ flex: 1 }} />
          <ActionButton
            label="Keep yours"
            onClick={() => resolve("yours")}
            blocked={detail ? null : "Conflict not loaded"}
            busy={busy}
          />
          <ActionButton
            label="Keep current"
            onClick={() => resolve("current")}
            blocked={detail ? null : "Conflict not loaded"}
            busy={busy}
          />
          <ActionButton
            label="Accept merged"
            onClick={() => resolve("merged")}
            blocked={mergedReason}
            busy={busy}
            primary
          />
        </div>
      </div>
    </div>
  );
}

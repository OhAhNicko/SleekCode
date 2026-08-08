import { useCallback, useEffect, useState } from "react";
import LoadingDots from "../LoadingDots";
import { MODAL_BACKDROP, MODAL_MAX_HEIGHT } from "../../lib/modal-layout";
import { useModalWhen } from "../../store/modalCoordinationSlice";
import { useKnowledgeStore } from "../../store/knowledgeStore";
import * as api from "../../lib/knowledge/api";
import { confirmAction } from "../../lib/prompt-modal";
import { relativeTime } from "../../lib/screenshots";
import MarkdownPreview from "../MarkdownPreview";
import {
  actorColor,
  actorLabel,
  type KnowledgeRevisionInfo,
  type KnowledgeRevisionSnapshot,
} from "../../lib/knowledge/types";

/**
 * Everything a document has ever been.
 *
 * Restore writes a NEW revision rather than rewinding to an old one, so
 * pressing it can never lose the current text — which is what makes it safe to
 * press while still unsure. The confirmation says so in as many words.
 */
export default function KnowledgeRevisionModal() {
  const modal = useKnowledgeStore((s) => s.openModal);
  const closeModal = useKnowledgeStore((s) => s.closeModal);
  const invalidate = useKnowledgeStore((s) => s.invalidateAfterOwnWrite);
  const open = modal?.kind === "history";
  const projectKey = open ? modal.projectKey : "";
  const entityId = open ? modal.entityId : "";
  const project = useKnowledgeStore((s) => (projectKey ? s.projects[projectKey] : undefined));

  useModalWhen("knowledge-history", open);

  const [revisions, setRevisions] = useState<KnowledgeRevisionInfo[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<KnowledgeRevisionSnapshot | null>(null);
  const [raw, setRaw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const title = project?.notes.find((n) => n.id === entityId)?.title ?? "Revision history";
  const filePath = project?.notes.find((n) => n.id === entityId)?.filePath ?? "";

  useEffect(() => {
    if (!open || !project) {
      setRevisions(null);
      setSelected(null);
      setSnapshot(null);
      setRaw(false);
      setError(null);
      return;
    }
    let cancelled = false;
    api
      .listRevisions(project.path, entityId)
      .then((list) => {
        if (cancelled) return;
        setRevisions(list);
        // Newest first, and the newest is what someone came to compare against.
        if (list.length > 0) setSelected(list[0].revision);
      })
      .catch((e) => {
        if (!cancelled) setError(api.knowledgeErrorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, project, entityId]);

  useEffect(() => {
    if (!open || !project || selected === null) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    setSnapshot(null);
    api
      .getRevision(project.path, entityId, selected)
      .then((snap) => {
        if (!cancelled) setSnapshot(snap);
      })
      .catch((e) => {
        if (!cancelled) setError(api.knowledgeErrorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, project, entityId, selected]);

  const restore = useCallback(async () => {
    if (!project || selected === null) return;
    const ok = await confirmAction({
      title: `Restore revision ${selected}?`,
      detail: "Creates a new revision with this content. Nothing is deleted.",
      confirmLabel: "Restore",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.restoreRevision(project.path, entityId, selected);
      invalidate(project.path);
      closeModal();
    } catch (e) {
      setError(api.knowledgeErrorText(e));
    } finally {
      setBusy(false);
    }
  }, [project, selected, entityId, invalidate, closeModal]);

  if (!open) return null;

  return (
    <div
      style={{ ...MODAL_BACKDROP, backgroundColor: "rgba(0,0,0,0.6)", zIndex: 250 }}
      onClick={closeModal}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "calc(100% - 64px)",
          maxWidth: 880,
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
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "14px 18px",
            borderBottom: "1px solid var(--ezy-border)",
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                color: "var(--ezy-text-muted)",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              History
            </div>
            <div
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 15px)",
                color: "var(--ezy-text)",
                fontWeight: 600,
                marginTop: 2,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {title}
            </div>
          </div>
          <span
            role="button"
            onClick={() => setRaw((v) => !v)}
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
              color: "var(--ezy-accent)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {raw ? "View formatted" : "View raw"}
          </span>
        </div>

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div
            style={{
              width: 230,
              flexShrink: 0,
              borderRight: "1px solid var(--ezy-border)",
              overflowY: "auto",
            }}
          >
            {revisions === null ? (
              <div
                style={{
                  padding: "10px 12px",
                  fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                  color: "var(--ezy-text-muted)",
                }}
              >
                <LoadingDots>Loading revisions</LoadingDots>
              </div>
            ) : revisions.length === 0 ? (
              <div
                style={{
                  padding: "10px 12px",
                  fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                  color: "var(--ezy-text-muted)",
                }}
              >
                No revisions recorded yet.
              </div>
            ) : (
              revisions.map((rev) => {
                const active = rev.revision === selected;
                return (
                  <div
                    key={rev.revision}
                    onClick={() => setSelected(rev.revision)}
                    style={{
                      padding: "7px 12px",
                      cursor: "pointer",
                      backgroundColor: active ? "var(--ezy-surface)" : "transparent",
                      borderBottom: "1px solid var(--ezy-border-subtle)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                        color: active ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          backgroundColor: actorColor(rev.actor),
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontVariantNumeric: "tabular-nums" }}>rev {rev.revision}</span>
                      <span style={{ color: "var(--ezy-text-muted)" }}>
                        · {actorLabel(rev.actor)}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                        color: "var(--ezy-text-muted)",
                        marginTop: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {relativeTime(rev.createdAt)}
                      {rev.reason ? ` · ${rev.reason}` : ""}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: raw ? 0 : "0 4px" }}>
            {error ? (
              <div
                style={{
                  padding: 16,
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                  color: "var(--ezy-red)",
                  wordBreak: "break-word",
                }}
              >
                {error}
              </div>
            ) : !snapshot ? (
              <div
                style={{
                  padding: 16,
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                  color: "var(--ezy-text-muted)",
                }}
              >
                {selected === null ? "Select a revision." : <LoadingDots>Loading snapshot</LoadingDots>}
              </div>
            ) : raw ? (
              <div
                style={{
                  padding: 16,
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                  lineHeight: 1.55,
                  color: "var(--ezy-text-secondary)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {snapshot.content}
              </div>
            ) : (
              // MarkdownPreview strips frontmatter itself, so a snapshot's `id:`
              // and `revision:` lines never render as a stray heading.
              <MarkdownPreview source={snapshot.content} filePath={filePath} />
            )}
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
          <button
            onClick={closeModal}
            style={{
              padding: "6px 14px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              fontFamily: "var(--ezy-font-ui)",
              color: "var(--ezy-text-secondary)",
              backgroundColor: "transparent",
              border: "1px solid var(--ezy-border)",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
              cursor: "pointer",
            }}
          >
            Close
          </button>
          <button
            onClick={() => void restore()}
            aria-disabled={selected === null || busy}
            data-tooltip={selected === null ? "Select a revision first" : undefined}
            style={{
              padding: "6px 14px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
              fontFamily: "var(--ezy-font-ui)",
              color: "var(--ezy-on-accent)",
              backgroundColor: "var(--ezy-accent)",
              border: "none",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
              cursor: selected === null || busy ? "default" : "pointer",
              opacity: selected === null || busy ? 0.6 : 1,
            }}
          >
            Restore as new revision
          </button>
        </div>
      </div>
    </div>
  );
}

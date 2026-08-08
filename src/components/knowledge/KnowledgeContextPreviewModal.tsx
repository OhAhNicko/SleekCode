import { useEffect, useRef, useState } from "react";
import { MODAL_BACKDROP, MODAL_MAX_HEIGHT } from "../../lib/modal-layout";
import { useModalWhen } from "../../store/modalCoordinationSlice";
import { useKnowledgeStore } from "../../store/knowledgeStore";
import { peekRefPreview, formatTokenEstimate } from "../../lib/knowledge/refs";
import type { ContextPackage } from "../../lib/knowledge/types";

/**
 * Exactly what the composer will append to the prompt.
 *
 * The whole point is that nothing is paraphrased: this is the literal text
 * that will be sent, plus the list of documents and revisions it was built
 * from. Someone about to hand several kilobytes to an agent is entitled to
 * read them first, and to see which revision of each they are handing over.
 */
export default function KnowledgeContextPreviewModal() {
  const modal = useKnowledgeStore((s) => s.openModal);
  const closeModal = useKnowledgeStore((s) => s.closeModal);
  const open = modal?.kind === "context-preview";

  useModalWhen("knowledge-context-preview", open);

  const [pkg, setPkg] = useState<ContextPackage | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  /**
   * Take the keyboard on open.
   *
   * Unlike the sidebar's modals, this one is raised from a composer whose
   * textarea deliberately keeps focus through the click (the strip's mousedown
   * preventDefaults so the popups do not flicker). Leaving focus there would
   * mean Enter submits the prompt behind the dialog the user opened to check it
   * first — so the dialog takes focus, which also blurs the composer and
   * settles its popups.
   */
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => closeRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open || modal.kind !== "context-preview") {
      setPkg(null);
      return;
    }
    // The strip resolved this moments ago; reading its package rather than
    // re-resolving is what keeps opening the dialog instant and keeps a
    // `record:false` preview from turning into a second service call.
    setPkg(peekRefPreview(modal.terminalId)?.pkg ?? null);
  }, [open, modal]);

  if (!open) return null;

  return (
    <div
      style={{ ...MODAL_BACKDROP, backgroundColor: "rgba(0,0,0,0.6)", zIndex: 250 }}
      onClick={closeModal}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            closeModal();
          }
        }}
        style={{
          width: "calc(100% - 64px)",
          maxWidth: 820,
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
            Knowledge context
          </div>
          <div
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 15px)",
              color: "var(--ezy-text)",
              fontWeight: 600,
              marginTop: 2,
            }}
          >
            {pkg
              ? `${pkg.sources.length} ${pkg.sources.length === 1 ? "document" : "documents"} · ${formatTokenEstimate(pkg.tokenEstimate)}`
              : "Nothing resolved yet"}
          </div>
          <div
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
              color: "var(--ezy-text-muted)",
              marginTop: 4,
            }}
          >
            This is appended below your prompt when you send it. Your own text is not changed.
          </div>
        </div>

        {pkg && pkg.sources.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "4px 14px",
              padding: "10px 18px",
              borderBottom: "1px solid var(--ezy-border-subtle)",
              flexShrink: 0,
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
              color: "var(--ezy-text-muted)",
            }}
          >
            {pkg.sources.map((s) => (
              <span key={s.entityId} style={{ fontVariantNumeric: "tabular-nums" }}>
                <span style={{ color: "var(--ezy-text-secondary)" }}>{s.title}</span> · rev{" "}
                {s.revision}
              </span>
            ))}
          </div>
        )}

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            margin: 18,
            marginTop: 12,
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
          {pkg
            ? pkg.renderedPromptContext
            : "The references in this prompt have not been resolved yet. Close this, wait a moment, and try again."}
        </div>

        {pkg?.truncated && (
          <div
            style={{
              padding: "0 18px 12px",
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
              color: "var(--ezy-text-muted)",
              flexShrink: 0,
            }}
          >
            Trimmed to fit the context budget — the last document was cut at a heading.
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            padding: "12px 18px",
            borderTop: "1px solid var(--ezy-border)",
            flexShrink: 0,
          }}
        >
          <button
            ref={closeRef}
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
        </div>
      </div>
    </div>
  );
}

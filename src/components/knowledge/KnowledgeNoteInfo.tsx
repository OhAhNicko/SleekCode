import LoadingDots from "../LoadingDots";
import { relativeTime } from "../../lib/screenshots";
import { actorColor, actorLabel, type KnowledgeNoteDetail } from "../../lib/knowledge/types";

/** The app's standard solid button (the Agent access "Set up" family): surface
 *  fill, real border, centered label. The quiet left-aligned handoff style
 *  read as metadata here, not as actions. */
function PanelButton({
  label,
  onClick,
  blocked,
}: {
  label: string;
  onClick: () => void;
  blocked: string | null;
}) {
  const disabled = !!blocked;
  return (
    <button
      onClick={() => {
        if (!disabled) onClick();
      }}
      aria-disabled={disabled}
      data-tooltip={blocked ?? undefined}
      style={{
        width: "100%",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "5px 10px",
        fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
        fontWeight: 500,
        fontFamily: "var(--ezy-font-ui)",
        color: disabled ? "var(--ezy-text-muted)" : "var(--ezy-text-secondary)",
        backgroundColor: "var(--ezy-surface)",
        border: "1px solid var(--ezy-border)",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
      }}
    >
      {label}
    </button>
  );
}

/**
 * What is known about the selected note, under the list.
 *
 * Answers the three questions a shared memory raises and nothing else: who
 * last touched this, what links to it, and how do I get it in front of an
 * agent. Anything longer belongs in the file itself, which is one Enter away.
 */
interface Props {
  detail: KnowledgeNoteDetail | null;
  /** Selected but not loaded yet — keeps the panel from flickering shut. */
  loadingId: string | null;
  onSelect: (entityId: string) => void;
  onHistory: () => void;
  onInsert: () => void;
  /** Non-null disables Insert and explains why. */
  insertBlocked: string | null;
}

export default function KnowledgeNoteInfo({
  detail,
  loadingId,
  onSelect,
  onHistory,
  onInsert,
  insertBlocked,
}: Props) {
  if (!detail) {
    if (!loadingId) return null;
    return (
      <div
        style={{
          borderTop: "1px solid var(--ezy-border-subtle)",
          padding: "8px 10px",
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          color: "var(--ezy-text-muted)",
          flexShrink: 0,
        }}
      >
        <LoadingDots>Loading note</LoadingDots>
      </div>
    );
  }

  return (
    <div
      style={{
        borderTop: "1px solid var(--ezy-border-subtle)",
        padding: "8px 10px",
        flexShrink: 0,
        maxHeight: "38%",
        overflowY: "auto",
        backgroundColor: "var(--ezy-surface)",
      }}
    >
      <div
        style={{
          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
          color: "var(--ezy-text)",
          fontWeight: 500,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {detail.title}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          marginTop: 3,
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          color: "var(--ezy-text-muted)",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: actorColor(detail.updatedBy),
            flexShrink: 0,
          }}
        />
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {actorLabel(detail.updatedBy)} · {relativeTime(detail.updatedAt)} · rev {detail.revision}
        </span>
      </div>

      {detail.tags.length > 0 && (
        <div
          style={{
            marginTop: 4,
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-text-muted)",
            wordBreak: "break-word",
          }}
        >
          {detail.tags.map((t) => `#${t}`).join(" ")}
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        <div
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--ezy-text-muted)",
          }}
        >
          Backlinks
        </div>
        {detail.backlinks.length === 0 ? (
          <div
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
              color: "var(--ezy-text-muted)",
              marginTop: 2,
            }}
          >
            No backlinks
          </div>
        ) : (
          detail.backlinks.map((link) => (
            <div
              key={link.id}
              onClick={() => onSelect(link.id)}
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                color: "var(--ezy-text-secondary)",
                cursor: "pointer",
                padding: "2px 0",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--ezy-text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--ezy-text-secondary)";
              }}
            >
              {link.title}
            </div>
          ))
        )}
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <div style={{ flex: 1 }}>
          <PanelButton label="History" onClick={onHistory} blocked={null} />
        </div>
        <div style={{ flex: 1 }}>
          <PanelButton label="Send to agent" onClick={onInsert} blocked={insertBlocked} />
        </div>
      </div>
    </div>
  );
}

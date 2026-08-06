/**
 * The notification card VISUAL — one source for both surfaces that draw it:
 * the in-app stack (OverlayRoot's NotifStack) and the custom OS popup window
 * (ToastRoot), so the two can never drift apart (design-parity rule).
 *
 * Pure presentation: no store, no overlay bus. The whole-card click belongs
 * to the caller's wrapper; only the dismiss X is handled here (it must
 * stopPropagation before the wrapper's click).
 */

export interface NotifCardData {
  id: string;
  projectName: string;
  paneLabel: string;
  timeHHMM: string;
  body: string;
  kind: "permission" | "finished" | "jira";
  hasAction?: boolean;
}

export function NotifCardVisual({
  card,
  innerRef,
  onDismiss,
}: {
  card: NotifCardData;
  /** The animated element (the overlay attaches its enter/leave WAAPI here). */
  innerRef?: (el: HTMLDivElement | null) => void;
  onDismiss: () => void;
}) {
  const permission = card.kind === "permission";
  return (
    <div
      ref={innerRef}
      style={{
        transformOrigin: "top right",
        background: "var(--ezy-surface-raised, #1c2128)",
        boxShadow: "inset 0 0 0 1px var(--ezy-border, rgba(255,255,255,0.12))",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
        padding: "9px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 5,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
            fontWeight: 600,
            lineHeight: "16px",
            padding: "0 6px",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
            // Jira: solid theme-neutral chip (blue is banned; a colored badge
            // would also read as a status, which this is not).
            background: permission
              ? "var(--ezy-red, #dc2626)"
              : card.kind === "jira"
                ? "var(--ezy-border, rgba(255,255,255,0.18))"
                : "var(--ezy-accent, #10a37f)",
            color: card.kind === "jira" ? "var(--ezy-text, #e6edf3)" : "#ffffff",
            flexShrink: 0,
          }}
        >
          {permission ? "Permission" : card.kind === "jira" ? "Jira" : "Done"}
        </span>
        <span
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            fontWeight: 600,
            color: "var(--ezy-text, #e6edf3)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flex: 1,
          }}
        >
          {card.projectName}
        </span>
        <span
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            fontVariantNumeric: "tabular-nums",
            flexShrink: 0,
          }}
        >
          {card.timeHHMM}
        </span>
        <svg
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          role="button"
          aria-label="Dismiss notification"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          style={{
            cursor: "pointer",
            color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            flexShrink: 0,
          }}
        >
          <path
            d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </div>
      {card.paneLabel && (
        <div
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {card.paneLabel}
        </div>
      )}
      <div
        style={{
          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
          lineHeight: 1.45,
          color: "var(--ezy-text-secondary, rgba(230,237,243,0.8))",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          wordBreak: "break-word",
        }}
      >
        {card.body}
      </div>
    </div>
  );
}

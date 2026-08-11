/**
 * The notification card VISUAL — one source for both surfaces that draw it:
 * the in-app stack (OverlayRoot's NotifStack) and the custom OS popup window
 * (ToastRoot), so the two can never drift apart (design-parity rule).
 *
 * Pure presentation: no store, no overlay bus. The whole-card click belongs
 * to the caller's wrapper; only the dismiss X is handled here (it must
 * stopPropagation before the wrapper's click).
 */

import { badgeInkFor } from "../lib/jira-colors";

export interface NotifCardData {
  id: string;
  projectName: string;
  paneLabel: string;
  timeHHMM: string;
  body: string;
  kind: "permission" | "finished" | "jira";
  hasAction?: boolean;
  /** Jira cards: the ticket's CURRENT status chip. The color is resolved in
   *  the main webview (statusColorFromState — the toast window has no store)
   *  and carried on the card, so both surfaces show the rail's exact hue. */
  jiraStatus?: { name: string; color: string };
  /** Jira cards: who did the thing — comment author, new assignee. Rendered
   *  emphasized before the flavor label ("Andreas · New comment"). */
  jiraActor?: string;
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
        {/* span+flex, not <button>: buttons inherit line-height and inflate
            compact headers. Hover = the app's icon-button convention
            (bg --ezy-border + ink brightens), via direct style mutation like
            the rest of the overlay's popups. */}
        <span
          role="button"
          aria-label="Dismiss notification"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "var(--ezy-border, rgba(255,255,255,0.12))";
            e.currentTarget.style.color = "var(--ezy-text, #e6edf3)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
            e.currentTarget.style.color = "var(--ezy-text-muted, rgba(230,237,243,0.5))";
          }}
          style={{
            width: 18,
            height: 18,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
            cursor: "pointer",
            color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
            flexShrink: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </span>
      </div>
      {(card.paneLabel || card.jiraStatus || card.jiraActor) && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {card.jiraStatus && (
            // Same chip recipe as JiraStatusBadge (solid status color, WCAG
            // ink) minus its fixed-width column mechanic — a card has no
            // status column to align to, so natural width + ellipsis cap.
            <span
              style={{
                padding: "1px 5px",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                backgroundColor: card.jiraStatus.color,
                color: badgeInkFor(card.jiraStatus.color),
                fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
                fontWeight: 600,
                lineHeight: 1.45,
                maxWidth: 140,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {card.jiraStatus.name}
            </span>
          )}
          {(card.jiraActor || card.paneLabel) && (
            <span
              style={{
                fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                color: "var(--ezy-text-muted, rgba(230,237,243,0.5))",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {card.jiraActor ? (
                <>
                  <span style={{ color: "var(--ezy-text, #e6edf3)", fontWeight: 500 }}>
                    {card.jiraActor}
                  </span>
                  {card.paneLabel ? ` · ${card.paneLabel}` : ""}
                </>
              ) : (
                card.paneLabel
              )}
            </span>
          )}
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

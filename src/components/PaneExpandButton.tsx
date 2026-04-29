import { useCallback } from "react";
import { useAppStore } from "../store";
import { paneFromRectRegistry } from "./FloatingPanesLayer";

interface PaneExpandButtonProps {
  /** When passed, used directly. Otherwise the button walks the DOM via closest("[data-pane-id]"). */
  paneId?: string;
  className?: string;
  title?: string;
}

/**
 * The "expand to fullscreen" button shown in an in-grid pane header.
 * Captures the pane's current rect at click time so the FLIP animation
 * has a source rect to animate from.
 */
export default function PaneExpandButton({ paneId, className, title }: PaneExpandButtonProps) {
  const expandPane = useAppStore((s) => s.expandPane);

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      let id = paneId;
      let rectEl: HTMLElement | null = null;
      if (!id) {
        rectEl = (e.currentTarget as HTMLElement).closest("[data-pane-id]") as HTMLElement | null;
        id = rectEl?.getAttribute("data-pane-id") ?? undefined;
      } else {
        rectEl = document.querySelector(`[data-pane-id="${CSS.escape(id)}"]`) as HTMLElement | null;
      }
      if (!id) return;
      if (rectEl) paneFromRectRegistry.set(id, rectEl.getBoundingClientRect());
      expandPane(id);
    },
    [paneId, expandPane]
  );

  return (
    <button
      onClick={onClick}
      title={title ?? "Expand to fullscreen"}
      className={className ?? "p-1 rounded transition-colors hover:bg-[var(--ezy-border)]"}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="var(--ezy-text-muted)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="2,5 2,2 5,2" />
        <polyline points="10,7 10,10 7,10" />
        <polyline points="7,2 10,2 10,5" />
        <polyline points="5,10 2,10 2,7" />
      </svg>
    </button>
  );
}

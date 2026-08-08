import { useCallback, useEffect, useState } from "react";
import { useOverlayToast } from "../../lib/useOverlayToast";
import { useAppStore } from "../../store";
import { useKnowledgeStore } from "../../store/knowledgeStore";
import { sameProjectPath } from "../../lib/knowledge/keys";

/** Long enough to read two lines, short enough to stop being furniture. */
const TOAST_MS = 6000;
/** The fallback notice is one line and needs less time on screen. */
const FALLBACK_TOAST_MS = 5000;

/**
 * "Knowledge refs not expanded" — the composer's failure notice.
 *
 * Rendered here, and not in PromptComposer, because a submit that fails also
 * CLOSES the composer in the default configuration: the toast state and the
 * parent's unmount committed in one React pass, so the notice never rendered at
 * all. Its whole job is to report a silent omission, so failing silently was
 * the one behaviour it could not have.
 *
 * No click action: the prompt has already been sent, and there is nothing the
 * user can usefully be taken to.
 */
function RefFallbackToast() {
  const nonce = useKnowledgeStore((s) => s.refFallbackNonce);
  const clear = useKnowledgeStore((s) => s.clearRefFallback);

  useEffect(() => {
    if (!nonce) return;
    const timer = setTimeout(clear, FALLBACK_TOAST_MS);
    return () => clearTimeout(timer);
  }, [nonce, clear]);

  useOverlayToast({
    id: "knowledge-ref-fallback",
    open: nonce > 0,
    payload:
      nonce > 0
        ? {
            placement: "bottom-right",
            variant: "surface",
            title: "Knowledge refs not expanded",
            detail: "The prompt was sent exactly as you typed it.",
            dismissable: true,
          }
        : null,
    onAction: clear,
  });

  return null;
}

/**
 * "Knowledge updated by Codex · STATE.md" — bottom right.
 *
 * An overlay toast rather than a pane notification card, because a knowledge
 * change is not bound to a pane: the agent that wrote it may have finished, and
 * the change matters to whichever pane the user works in next.
 *
 * Whether a change deserves a toast at all is decided in the store, where the
 * selection and focus state that answer "are they already looking at this?"
 * live. This component only shows what it is handed and routes the click.
 */
export default function KnowledgeToastHost() {
  const toast = useKnowledgeStore((s) => s.lastToast);
  const clearToast = useKnowledgeStore((s) => s.clearToast);
  const select = useKnowledgeStore((s) => s.select);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!toast) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
      clearToast();
    }, TOAST_MS);
    return () => clearTimeout(timer);
    // `nonce` is what makes a repeat of the same text restart the timer.
  }, [toast?.nonce, toast, clearToast]);

  const handleAction = useCallback(
    (action: string) => {
      if (action === "open" && toast) {
        const store = useAppStore.getState();
        // The change may belong to a project that is not in front. Switch to it
        // first, or "open the sidebar" would show a different project's memory.
        const tab = store.tabs.find((t) => sameProjectPath(t.workingDir, toast.projectPath));
        if (tab && tab.id !== store.activeTabId) store.setActiveTab(tab.id);
        store.setSidebarTab("knowledge");
        if (!useAppStore.getState().sidebarOpen) useAppStore.getState().toggleSidebar();
        if (toast.entityId) select(toast.projectPath, toast.entityId);
      }
      setVisible(false);
      clearToast();
    },
    [toast, select, clearToast],
  );

  const active = visible && !!toast;

  useOverlayToast({
    id: "knowledge-update",
    open: active,
    payload: active
      ? {
          placement: "bottom-right",
          variant: "surface",
          title: toast.title,
          detail: toast.detail,
          dismissable: true,
          clickAction: "open",
        }
      : null,
    onAction: handleAction,
  });

  return <RefFallbackToast />;
}

/**
 * Open a row's COMPACT context menu from a hamburger affordance.
 *
 * Synthesizes a `contextmenu` event on the row element, anchored under the
 * icon. Same event path and providers as a real right-click — the temporary
 * `data-ctx-compact` flag is all that differs, and a provider answers it with a
 * strict subset of the full menu, so the two cannot drift. The flag comes off
 * right after the dispatch (menu build is synchronous inside it), so an actual
 * right-click on the row still gets the full menu.
 *
 * Shared by every surface that pairs a row with a hamburger: the Jira ticket
 * rail and the v2 tab bar's ticket tree.
 */
export function openCompactRowMenu(anchor: Element): void {
  const rowEl = anchor.closest("[data-ctx-surface]");
  if (!rowEl) return;
  const r = anchor.getBoundingClientRect();
  rowEl.setAttribute("data-ctx-compact", "1");
  try {
    rowEl.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(r.left),
        clientY: Math.round(r.bottom + 2),
      }),
    );
  } finally {
    rowEl.removeAttribute("data-ctx-compact");
  }
}

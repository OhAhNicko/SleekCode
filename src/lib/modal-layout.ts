import type { CSSProperties } from "react";

/**
 * Shared vertical placement for the app's centered dialogs.
 *
 * Every modal used to hard-code its own `alignItems: "flex-start"` plus
 * `paddingTop: <N>vh`, and the value had drifted into three cohorts (10 / 12 /
 * 15vh). Worse, a fixed top offset positions a dialog's TOP EDGE, so where the
 * dialog optically sits depends on how tall it is: the ~200px Unlock Keychain
 * prompt at 12vh had its middle at ~21% of the window and read as stuck to the
 * ceiling, while a 600px wizard at that same 12vh looked roughly centered.
 *
 * So center the panel and lift it by a fixed amount instead. The panel's
 * MIDDLE — not its top edge — then lands at a constant fraction of the window
 * whatever the panel's height:
 *
 *   panel middle = (100vh - MODAL_OPTICAL_LIFT) / 2 = 38vh
 *
 * 38% is the golden-ratio placement: clearly above dead center, which reads
 * low and heavy for a dialog, without hugging the top.
 */
export const MODAL_OPTICAL_LIFT = "24vh";

/**
 * Tallest a modal panel may be.
 *
 * The lift eats usable height — the backdrop's content box is only
 * `100vh - MODAL_OPTICAL_LIFT` = 76vh. Under `align-items: center` a flex item
 * taller than its container overflows EQUALLY in both directions, and the top
 * overflow is unreachable because a fixed backdrop does not scroll. A panel
 * must therefore fit inside 76vh; 68vh leaves 4vh of clearance above a
 * full-height panel. Raise the lift and this must come down with it.
 */
export const MODAL_MAX_HEIGHT = "68vh";

/**
 * Backdrop geometry every modal shares. Spread it into the backdrop's inline
 * style and keep `background`/`backgroundColor` and `zIndex` local — scrim
 * opacity and stacking order are genuinely per-dialog, placement is not:
 *
 *   style={{ ...MODAL_BACKDROP, backgroundColor: "rgba(0,0,0,0.6)", zIndex: 200 }}
 */
export const MODAL_BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  paddingBottom: MODAL_OPTICAL_LIFT,
};

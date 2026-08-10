/**
 * The dismiss X in a dialog header.
 *
 * Five dialogs had copy-pasted the same bare `<svg onClick>` with nothing but a
 * pointer cursor — no hit area beyond the 14px glyph and no hover at all, so
 * the app's most-clicked control was the only icon button in MADE that gave no
 * feedback. This is the canonical icon-button treatment
 * (`DevServerTerminalHost`'s `HeaderIconButton`, `KeyboardShortcutsModal`):
 * a padded, rounded target that fills with `--ezy-accent-glow` on hover.
 *
 * NOT the red hover that pane and tab closers use. Red means "this destroys
 * something" (`DevServerTerminalHost` declines it for its own panel X for
 * exactly this reason); dismissing a dialog destroys nothing.
 *
 * 22px, not the 24px of a pane header: the dialog header bar is 32px tall and
 * 24 leaves the target visually wedged into it.
 *
 * A real `<button>` despite the compact-header gotcha in CLAUDE.md — that one
 * bites unstyled buttons, which inherit `line-height: 1.5`. Explicit
 * width/height with `padding: 0` and `display: flex` leaves nothing for the
 * line box to inflate, and it buys the keyboard focus and the label that a bare
 * svg never had.
 */
export default function ModalCloseButton({
  onClose,
  label = "Close",
}: {
  onClose: () => void;
  /** Override when "Close" is ambiguous — e.g. a browser nested inside a dialog. */
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClose}
      style={{
        width: 22,
        height: 22,
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "transparent",
        border: "none",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
        // Drives the glyph too — the svg strokes with `currentColor`, so one
        // property change lifts the icon and one hover handler covers both.
        color: "var(--ezy-text-muted)",
        cursor: "pointer",
        flexShrink: 0,
        transition: "background-color 120ms ease, color 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
        e.currentTarget.style.color = "var(--ezy-text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
        e.currentTarget.style.color = "var(--ezy-text-muted)";
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        <line x1="4" y1="4" x2="12" y2="12" />
        <line x1="12" y1="4" x2="4" y2="12" />
      </svg>
    </button>
  );
}

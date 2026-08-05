import { useCallback, useEffect, useRef, useState } from "react";
import { SWATCH_PRESET_COLORS } from "../lib/color-overrides";

/** Normalize user hex input to "#rrggbb". Accepts #RGB / #RRGGBB with or
 *  without the leading "#"; rejects everything else INCLUDING 8-digit hex —
 *  the native renderer drops alpha where xterm would honor it, so alpha
 *  must never enter a preset. */
export function normalizeHexColor(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s.startsWith("#")) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/.test(s)) {
    s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

/**
 * Swatch-button color picker for Settings (Terminal colors section).
 *
 * The trigger is a swatch painted with the color that ACTUALLY renders right
 * now; an overridden color carries the app's inset accent ring (the theme-card
 * selection trick — border width never changes, so nothing shifts). The
 * popover replicates the Settings Dropdown portal: fixed-position, capture-
 * phase dismissal, surface-raised card. Content is the annotation toolbar's
 * swatch vocabulary — Sorbet's pastels — plus a Custom row (hex field + OS
 * color dialog) and a "Theme default" reset when an override is set.
 */
export default function ColorSwatchPicker({
  value,
  effectiveColor,
  onChange,
  disabled,
  label,
}: {
  /** Current override, or null when the color follows the theme. */
  value: string | null;
  /** The color that actually renders now (override applied, else theme). */
  effectiveColor: string;
  /** null = reset to theme default. */
  onChange: (hex: string | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [hexDraft, setHexDraft] = useState("");
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const colorInputRef = useRef<HTMLInputElement | null>(null);

  const POP_WIDTH = 236;
  // Tallest the popover gets (swatches + expanded custom row + reset) — used
  // only to decide whether to open upward near the viewport bottom.
  const POP_EST_HEIGHT = 150;

  const measure = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    // The popover must stay over the WEBVIEW's own area. Settings shares the
    // window with native-pane child HWNDs, and NO z-index can lift DOM above
    // a child window — so instead of growing rightward into the pane region,
    // right-align to the trigger (swatches sit at the right edge of the
    // settings column) and clamp inside the viewport.
    const left = Math.max(8, Math.min(b.right - POP_WIDTH, window.innerWidth - POP_WIDTH - 8));
    // Near the viewport bottom, anchor to the trigger's TOP and grow upward
    // (bottom-positioned so the custom-row expansion also grows upward).
    if (b.bottom + 4 + POP_EST_HEIGHT > window.innerHeight) {
      setRect({ left, bottom: window.innerHeight - b.top + 4 });
    } else {
      setRect({ left, top: b.bottom + 4 });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    measure();
    // Capture-phase window listeners, target-tested by ref — same dismissal
    // contract as the Settings Dropdown (see its comment for why capture).
    const inside = (t: EventTarget | null) =>
      t instanceof Node &&
      (popRef.current?.contains(t) === true || btnRef.current?.contains(t) === true);
    const onPointerDown = (e: Event) => {
      if (!inside(e.target)) setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, measure]);

  const commitHex = (raw: string) => {
    const hex = normalizeHexColor(raw);
    if (!hex) return;
    onChange(hex);
    setOpen(false);
  };

  // `<input type="color">` only accepts "#rrggbb" — strip any theme alpha.
  const colorDialogSeed = normalizeHexColor(effectiveColor.slice(0, 7)) ?? "#000000";
  const overridden = value !== null;
  const hexValid = normalizeHexColor(hexDraft) !== null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-label={label}
        title={label}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          measure();
          setCustomOpen(false);
          setHexDraft(value ?? "");
          setOpen((v) => !v);
        }}
        style={{
          width: 22,
          height: 22,
          padding: 0,
          flexShrink: 0,
          backgroundColor: effectiveColor,
          // Ring width lives INSIDE the box (theme-card trick) so an
          // override appearing never nudges the row.
          border: "1px solid",
          borderColor: overridden ? "var(--ezy-accent)" : "var(--ezy-border)",
          boxShadow: overridden ? "inset 0 0 0 1px var(--ezy-accent)" : "none",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
          boxSizing: "border-box",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.4 : 1,
        }}
      />
      {open && rect && (
        <div
          ref={popRef}
          style={{
            position: "fixed",
            left: rect.left,
            top: rect.top,
            bottom: rect.bottom,
            width: POP_WIDTH,
            zIndex: 1000,
            padding: 8,
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
            backgroundColor: "var(--ezy-surface-raised)",
            border: "1px solid var(--ezy-border)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {/* Sorbet pastels + purple/white — the annotation toolbar's swatch
              vocabulary at popover size. */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {SWATCH_PRESET_COLORS.map((c) => {
              const active = value?.toLowerCase() === c;
              return (
                <div
                  key={c}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  onClick={() => {
                    onChange(c);
                    setOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      onChange(c);
                      setOpen(false);
                    }
                  }}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                    cursor: "pointer",
                    backgroundColor: c,
                    flexShrink: 0,
                    // Border width changes INSIDE the box — a selection never
                    // nudges its neighbours (annotation toolbar convention).
                    border: active ? "2px solid #fff" : "1px solid rgba(0,0,0,0.35)",
                    boxSizing: "border-box",
                  }}
                />
              );
            })}
          </div>
          {!customOpen ? (
            <button
              type="button"
              onClick={() => {
                setHexDraft(value ?? "");
                setCustomOpen(true);
              }}
              style={{
                padding: "5px 8px",
                fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                fontFamily: "inherit",
                textAlign: "left",
                color: "var(--ezy-text-secondary)",
                backgroundColor: "transparent",
                border: "1px solid var(--ezy-border)",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--ezy-text)";
                e.currentTarget.style.borderColor = "var(--ezy-border-light)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--ezy-text-secondary)";
                e.currentTarget.style.borderColor = "var(--ezy-border)";
              }}
            >
              Custom color…
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="text"
                value={hexDraft}
                placeholder="#rrggbb"
                autoFocus
                onChange={(e) => setHexDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitHex(hexDraft);
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "5px 8px",
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                  fontFamily: "var(--ezy-font-mono, ui-monospace, Menlo, monospace)",
                  color: "var(--ezy-text)",
                  backgroundColor: "var(--ezy-surface)",
                  border: "1px solid",
                  // Only flag a NON-EMPTY invalid draft — an empty field is
                  // "still typing", not an error.
                  borderColor:
                    hexDraft && !hexValid ? "var(--ezy-red)" : "var(--ezy-border)",
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                  outline: "none",
                }}
              />
              {/* OS color dialog. The visible well proxies a hidden native
                  input so the well can render at swatch size and radius. */}
              <div
                role="button"
                tabIndex={0}
                aria-label="Open color dialog"
                title="Open color dialog"
                onClick={() => colorInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    colorInputRef.current?.click();
                  }
                }}
                style={{
                  position: "relative",
                  width: 26,
                  height: 26,
                  flexShrink: 0,
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                  border: "1px solid var(--ezy-border)",
                  boxSizing: "border-box",
                  cursor: "pointer",
                  overflow: "hidden",
                  // Conic wheel = universal "pick any color" mark; hue-only
                  // (no yellow/blue chrome tokens involved — this is content).
                  background:
                    "conic-gradient(#f00, #ff8000, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
                }}
              >
                <input
                  ref={colorInputRef}
                  type="color"
                  value={colorDialogSeed}
                  onChange={(e) => {
                    const hex = normalizeHexColor(e.target.value);
                    if (hex) onChange(hex);
                  }}
                  style={{
                    position: "absolute",
                    inset: 0,
                    opacity: 0,
                    width: "100%",
                    height: "100%",
                    cursor: "pointer",
                  }}
                />
              </div>
              <button
                type="button"
                disabled={!hexValid}
                onClick={() => commitHex(hexDraft)}
                style={{
                  padding: "5px 10px",
                  fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                  fontFamily: "inherit",
                  color: hexValid ? "var(--ezy-on-accent, #fff)" : "var(--ezy-text-muted)",
                  backgroundColor: hexValid ? "var(--ezy-accent)" : "var(--ezy-surface)",
                  border: "1px solid",
                  borderColor: hexValid ? "var(--ezy-accent)" : "var(--ezy-border)",
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                  cursor: hexValid ? "pointer" : "default",
                  flexShrink: 0,
                }}
              >
                Set
              </button>
            </div>
          )}
          {overridden && (
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              style={{
                padding: "5px 8px",
                fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                fontFamily: "inherit",
                textAlign: "left",
                color: "var(--ezy-text-secondary)",
                backgroundColor: "transparent",
                border: "1px solid var(--ezy-border)",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--ezy-text)";
                e.currentTarget.style.borderColor = "var(--ezy-border-light)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--ezy-text-secondary)";
                e.currentTarget.style.borderColor = "var(--ezy-border)";
              }}
            >
              Theme default
            </button>
          )}
        </div>
      )}
    </>
  );
}

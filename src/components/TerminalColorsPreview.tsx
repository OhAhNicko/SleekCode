import type { EffectiveTerminalTheme } from "../lib/themes";

/**
 * A fake five-line terminal painted with REAL theme values, so the Terminal
 * colors section answers "what does this actually look like" without opening a
 * pane. Every color comes in as an inline style off the passed theme — nothing
 * here reads a CSS var for pane content, because the whole point is to show the
 * terminal's palette rather than the app chrome's.
 *
 * Purely presentational: no state, no handlers, no focus. It also cannot block
 * anything — the contrast note under it is information, never a gate.
 */

/** The three MADE extensions are optional on EffectiveTerminalTheme; these are
 *  the same fallbacks the pickers use so the strip never renders a hole. */
const LINK_FALLBACK = "#92bcff";
const MATCH_FALLBACK = "#e6e6e6";
const MATCH_ACTIVE_FALLBACK = "#39d353";

interface Rgb { r: number; g: number; b: number }

/** Parses "#rgb", "#rrggbb", "#rrggbbaa", "rgb()" and "rgba()" — the shapes a
 *  theme value can take once tint/lift have composed alpha into it. Anything
 *  else returns null, which callers treat as "cannot judge", not "bad". */
function parseColor(raw: string | undefined | null): { rgb: Rgb; a: number } | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  const hex = s.startsWith("#") ? s.slice(1) : null;
  if (hex && /^[0-9a-f]+$/.test(hex)) {
    if (hex.length === 3) {
      return {
        rgb: {
          r: parseInt(hex[0] + hex[0], 16),
          g: parseInt(hex[1] + hex[1], 16),
          b: parseInt(hex[2] + hex[2], 16),
        },
        a: 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        rgb: {
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16),
        },
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }
  const fn = s.match(/^rgba?\(([^)]+)\)$/);
  if (!fn) return null;
  const parts = fn[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  const a = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1;
  return { rgb: { r: parts[0], g: parts[1], b: parts[2] }, a };
}

/** Flattens a possibly-translucent color onto an opaque one. A selection
 *  background carrying alpha is judged against what shows through it, which is
 *  the only reading that matches what the eye gets. */
function flatten(raw: string | undefined | null, under: Rgb | null): Rgb | null {
  const c = parseColor(raw);
  if (!c) return null;
  if (c.a >= 1) return c.rgb;
  if (!under) return null;
  return {
    r: c.rgb.r * c.a + under.r * (1 - c.a),
    g: c.rgb.g * c.a + under.g * (1 - c.a),
    b: c.rgb.b * c.a + under.b * (1 - c.a),
  };
}

/** WCAG 2.1 relative luminance: sRGB channels linearized, then weighted. */
function luminance({ r, g, b }: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contrast ratio, or null when either color could not be parsed. */
function contrastRatio(fg: Rgb | null, bg: Rgb | null): number | null {
  if (!fg || !bg) return null;
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const WCAG_AA = 4.5;

export default function TerminalColorsPreview({ theme }: { theme: EffectiveTerminalTheme }) {
  const fg = theme.foreground ?? "#e6e6e6";
  const bg = theme.background ?? "#0d0d11";
  const green = theme.green ?? fg;
  const red = theme.red ?? fg;
  const link = theme.link ?? LINK_FALLBACK;
  const match = theme.searchMatch ?? MATCH_FALLBACK;
  const matchActive = theme.searchMatchActive ?? MATCH_ACTIVE_FALLBACK;
  const selBg = theme.selectionBackground ?? fg;
  const selFg = theme.selectionForeground ?? fg;

  const canvas = flatten(bg, null);
  const textRatio = contrastRatio(flatten(fg, canvas), canvas);
  const selRatio = contrastRatio(
    flatten(selFg, flatten(selBg, canvas)),
    flatten(selBg, canvas),
  );

  // One line, worst offender only — two stacked warnings read as an error
  // state, and the fix for either is the same move.
  const failing = [
    textRatio !== null && textRatio < WCAG_AA ? { what: "text on background", ratio: textRatio } : null,
    selRatio !== null && selRatio < WCAG_AA ? { what: "selected text", ratio: selRatio } : null,
  ].filter((x): x is { what: string; ratio: number } => x !== null);
  const worst = failing.sort((a, b) => a.ratio - b.ratio)[0] ?? null;

  const line: React.CSSProperties = { whiteSpace: "pre", minHeight: 18 };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        aria-hidden
        style={{
          backgroundColor: bg,
          color: fg,
          border: "1px solid var(--ezy-border)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
          padding: 10,
          fontFamily: '"Hack", monospace',
          fontSize: 12,
          lineHeight: 1.5,
          overflowX: "auto",
          userSelect: "none",
        }}
      >
        {/* U+276F, the prompt chevron every shell theme draws — a punctuation
            glyph, not an emoji. */}
        <div style={line}>
          <span style={{ color: green }}>❯</span>
          <span style={{ color: fg }}> git diff --stat</span>
        </div>
        <div style={{ ...line, color: green }}>+ added line</div>
        <div style={{ ...line, color: red }}>- removed line</div>
        <div style={line}>
          <span style={{ color: link, textDecoration: "underline" }}>https://made.dev</span>
          <span>  </span>
          <span style={{ backgroundColor: match, color: "#000" }}>match</span>
          <span>  </span>
          <span style={{ backgroundColor: matchActive, color: "#000" }}>match</span>
        </div>
        <div style={line}>
          <span style={{ backgroundColor: selBg, color: selFg }}>selected text</span>
        </div>
      </div>
      {worst && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--ezy-text-muted)",
            lineHeight: 1.4,
          }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
            <path
              d="M8 2.5 L14.5 13.5 H1.5 Z"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
            <path d="M8 6.5 v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <circle cx="8" cy="11.6" r="0.7" fill="currentColor" />
          </svg>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            Low contrast: {worst.what} is {worst.ratio.toFixed(1)}:1 — aim for 4.5:1 or higher.
          </span>
        </div>
      )}
    </div>
  );
}

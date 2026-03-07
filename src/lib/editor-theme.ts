import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { EzyDevTheme } from "./themes";

/**
 * Build a CodeMirror 6 theme from an EzyDevTheme.
 */
export function buildEditorTheme(theme: EzyDevTheme): Extension {
  const s = theme.surface;
  const t = theme.terminal;

  return EditorView.theme(
    {
      "&": {
        backgroundColor: s.bg,
        color: s.text,
        fontFamily: "'Hack', 'Geist Mono', 'Cascadia Code', 'Fira Code', monospace",
        fontSize: "13px",
      },
      ".cm-content": {
        caretColor: t.cursor ?? s.accent,
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: t.cursor ?? s.accent,
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: t.selectionBackground ?? s.borderSubtle,
      },
      ".cm-panels": {
        backgroundColor: s.surface,
        color: s.text,
      },
      ".cm-panels.cm-panels-top": {
        borderBottom: `1px solid ${s.border}`,
      },
      ".cm-searchMatch": {
        backgroundColor: s.accentGlow,
        outline: `1px solid ${s.accent}`,
      },
      ".cm-activeLine": {
        backgroundColor: `${s.surface}80`,
      },
      ".cm-selectionMatch": {
        backgroundColor: s.accentGlow,
      },
      ".cm-gutters": {
        backgroundColor: s.surface,
        color: s.textMuted,
        border: "none",
        borderRight: `1px solid ${s.border}`,
      },
      ".cm-activeLineGutter": {
        backgroundColor: s.surfaceRaised,
        color: s.text,
      },
      ".cm-foldPlaceholder": {
        backgroundColor: s.border,
        border: "none",
        color: s.textMuted,
      },
      ".cm-tooltip": {
        backgroundColor: s.surfaceRaised,
        border: `1px solid ${s.border}`,
        color: s.text,
      },
      ".cm-tooltip .cm-tooltip-arrow:before, .cm-tooltip .cm-tooltip-arrow:after": {
        borderTopColor: s.surfaceRaised,
        borderBottomColor: s.surfaceRaised,
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: s.accentGlow,
        color: s.text,
      },
    },
    { dark: true }
  );
}

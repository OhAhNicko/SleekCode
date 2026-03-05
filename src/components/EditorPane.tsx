import { useEffect, useRef, useState, useCallback } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { css } from "@codemirror/lang-css";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter } from "@codemirror/language";
import { closeBrackets } from "@codemirror/autocomplete";
import { invoke } from "@tauri-apps/api/core";
import { getTheme } from "../lib/themes";
import { buildEditorTheme } from "../lib/editor-theme";
import { useAppStore } from "../store";
import type { Extension } from "@codemirror/state";

interface EditorPaneProps {
  filePath: string;
  language?: string;
  onClose: () => void;
}

function detectLanguage(filePath: string): Extension[] {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
    case "jsx":
      return [javascript()];
    case "ts":
    case "tsx":
      return [javascript({ typescript: true, jsx: ext.includes("x") })];
    case "py":
      return [python()];
    case "css":
      return [css()];
    default:
      return [];
  }
}

function getLanguageLabel(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js": return "JavaScript";
    case "jsx": return "JSX";
    case "ts": return "TypeScript";
    case "tsx": return "TSX";
    case "py": return "Python";
    case "css": return "CSS";
    case "html": return "HTML";
    case "json": return "JSON";
    case "md": return "Markdown";
    case "rs": return "Rust";
    case "toml": return "TOML";
    case "yaml":
    case "yml": return "YAML";
    default: return ext?.toUpperCase() ?? "Plain";
  }
}

export default function EditorPane({ filePath, onClose }: EditorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modified, setModified] = useState(false);
  const [saving, setSaving] = useState(false);
  const themeId = useAppStore((s) => s.themeId);
  const theme = getTheme(themeId);

  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const langLabel = getLanguageLabel(filePath);

  const handleSave = useCallback(async () => {
    if (!viewRef.current) return;
    setSaving(true);
    try {
      const content = viewRef.current.state.doc.toString();
      await invoke("write_file", { path: filePath, content });
      setModified(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [filePath]);

  useEffect(() => {
    if (!containerRef.current) return;
    let view: EditorView | null = null;

    (async () => {
      try {
        const content = await invoke<string>("read_file", { path: filePath });

        if (!containerRef.current) return;

        const langExts = detectLanguage(filePath);
        const editorTheme = buildEditorTheme(theme);

        const state = EditorState.create({
          doc: content,
          extensions: [
            lineNumbers(),
            highlightActiveLine(),
            highlightActiveLineGutter(),
            foldGutter(),
            history(),
            bracketMatching(),
            closeBrackets(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            ...langExts,
            editorTheme,
            keymap.of([
              ...defaultKeymap,
              ...historyKeymap,
              {
                key: "Mod-s",
                run: () => {
                  handleSave();
                  return true;
                },
              },
            ]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                setModified(true);
              }
            }),
          ],
        });

        view = new EditorView({
          state,
          parent: containerRef.current,
        });
        viewRef.current = view;
        setLoading(false);
      } catch (e) {
        setError(String(e));
        setLoading(false);
      }
    })();

    return () => {
      view?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // Theme hot-swap for editor: destroy and recreate with new theme
  // EditorView.reconfigure is not available as a static — we skip dynamic
  // theme swap and rely on component remount via the key prop approach.
  // The initial creation already uses the current theme.

  return (
    <div
      className="flex flex-col h-full w-full"
      style={{ backgroundColor: "var(--ezy-bg)" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between select-none"
        style={{
          height: 28,
          backgroundColor: "var(--ezy-surface)",
          borderBottom: "1px solid var(--ezy-border)",
          padding: "0 8px",
        }}
      >
        <div className="flex items-center gap-2">
          {/* File icon */}
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.3"
          >
            <rect x="3" y="1" width="10" height="14" rx="1" />
            <line x1="5.5" y1="4" x2="10.5" y2="4" strokeLinecap="round" />
            <line x1="5.5" y1="6.5" x2="10.5" y2="6.5" strokeLinecap="round" />
            <line x1="5.5" y1="9" x2="8" y2="9" strokeLinecap="round" />
          </svg>
          <span
            className="text-[11px] font-medium"
            style={{ color: "var(--ezy-text)" }}
          >
            {fileName}
            {modified && <span style={{ color: "var(--ezy-accent)", marginLeft: 4 }}>*</span>}
          </span>
          <span
            style={{
              fontSize: 9,
              padding: "1px 5px",
              borderRadius: 3,
              backgroundColor: "var(--ezy-border)",
              color: "var(--ezy-text-muted)",
              fontWeight: 600,
            }}
          >
            {langLabel}
          </span>
          {saving && (
            <span style={{ fontSize: 10, color: "var(--ezy-text-muted)" }}>
              Saving...
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleSave}
            title="Save (Ctrl+S)"
            disabled={!modified || saving}
            className="p-1 rounded transition-colors"
            style={{
              backgroundColor: "transparent",
              opacity: modified ? 1 : 0.4,
              border: "none",
              cursor: modified ? "pointer" : "default",
            }}
            onMouseEnter={(e) => { if (modified) e.currentTarget.style.backgroundColor = "var(--ezy-border)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--ezy-text-muted)"
              strokeWidth="1.3"
              strokeLinecap="round"
            >
              <path d="M3 14V2h8l2 2v10H3z" />
              <path d="M5 2v4h5V2" />
              <path d="M5 14v-4h6v4" />
            </svg>
          </button>
          <button
            onClick={onClose}
            title="Close Editor"
            className="p-1 rounded transition-colors group"
            style={{ border: "none", backgroundColor: "transparent", cursor: "pointer" }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--ezy-text-muted)"
              strokeWidth="1.5"
              strokeLinecap="round"
              className="group-hover:stroke-[var(--ezy-red)]"
            >
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Editor content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: "var(--ezy-text-muted)", fontSize: 13 }}
          >
            Loading...
          </div>
        ) : error ? (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: "var(--ezy-red)", fontSize: 13 }}
          >
            {error}
          </div>
        ) : null}
        <div ref={containerRef} className="h-full" />
      </div>
    </div>
  );
}

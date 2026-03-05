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

interface FileViewerPaneProps {
  initialFiles: string[];
  initialActive: string;
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

function getFileIcon(filePath: string) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  let color = "var(--ezy-text-muted)";
  let label = "";

  switch (ext) {
    case "ts": color = "#3178c6"; label = "TS"; break;
    case "tsx": color = "#3178c6"; label = "TSX"; break;
    case "js": color = "#f0db4f"; label = "JS"; break;
    case "jsx": color = "#f0db4f"; label = "JSX"; break;
    case "py": color = "#3776ab"; label = "PY"; break;
    case "rs": color = "#dea584"; label = "RS"; break;
    case "css": color = "#563d7c"; label = "CSS"; break;
    case "json": color = "#6d8086"; label = "{ }"; break;
    default: label = ext?.toUpperCase().slice(0, 3) ?? ""; break;
  }

  return (
    <span
      className="text-[9px] font-bold leading-none rounded px-1 py-[1px] shrink-0"
      style={{
        color: "#fff",
        backgroundColor: color,
        minWidth: 18,
        textAlign: "center",
      }}
    >
      {label}
    </span>
  );
}

export default function FileViewerPane({
  initialFiles,
  initialActive,
  onClose,
}: FileViewerPaneProps) {
  const [files, setFiles] = useState<string[]>(initialFiles);
  const [activeFile, setActiveFile] = useState(initialActive);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modified, setModified] = useState(false);
  const [saving, setSaving] = useState(false);
  const themeId = useAppStore((s) => s.themeId);
  const theme = getTheme(themeId);
  const tabsRef = useRef<HTMLDivElement>(null);

  const fileName = activeFile.split(/[\\/]/).pop() || activeFile;
  const langLabel = getLanguageLabel(activeFile);

  // Listen for files being added to this viewer
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.filePath) return;
      setFiles((prev) => {
        if (prev.includes(detail.filePath)) {
          setActiveFile(detail.filePath);
          return prev;
        }
        const next = [...prev, detail.filePath];
        setActiveFile(detail.filePath);
        return next;
      });
    };
    window.addEventListener("ezydev:fileviewer-add", handler);
    return () => window.removeEventListener("ezydev:fileviewer-add", handler);
  }, []);

  const handleSave = useCallback(async () => {
    if (!viewRef.current) return;
    setSaving(true);
    try {
      const content = viewRef.current.state.doc.toString();
      await invoke("write_file", { path: activeFile, content });
      setModified(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [activeFile]);

  // Load file into editor
  useEffect(() => {
    if (!containerRef.current) return;
    let view: EditorView | null = null;
    setLoading(true);
    setError(null);
    setModified(false);

    (async () => {
      try {
        const content = await invoke<string>("read_file", { path: activeFile });
        if (!containerRef.current) return;

        const langExts = detectLanguage(activeFile);
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
  }, [activeFile]);

  const handleCloseTab = useCallback(
    (filePath: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const next = files.filter((f) => f !== filePath);
      if (next.length === 0) {
        onClose();
        return;
      }
      if (activeFile === filePath) {
        const idx = files.indexOf(filePath);
        setActiveFile(next[Math.min(idx, next.length - 1)]);
      }
      setFiles(next);
    },
    [files, activeFile, onClose]
  );

  const handleTabClick = useCallback((filePath: string) => {
    setActiveFile(filePath);
  }, []);

  return (
    <div className="flex flex-col h-full w-full" style={{ backgroundColor: "var(--ezy-bg)" }}>
      {/* Tab bar */}
      <div
        ref={tabsRef}
        className="flex items-center shrink-0 overflow-x-auto"
        style={{
          height: 32,
          backgroundColor: "var(--ezy-surface)",
          borderBottom: "1px solid var(--ezy-border)",
        }}
      >
        {/* File tabs */}
        <div className="flex items-stretch flex-1 min-w-0 overflow-x-auto">
          {files.map((fp) => {
            const isActive = fp === activeFile;
            const name = fp.split(/[\\/]/).pop() || fp;

            return (
              <div
                key={fp}
                onClick={() => handleTabClick(fp)}
                className="flex items-center gap-1.5 px-3 cursor-pointer shrink-0 relative group"
                style={{
                  height: 32,
                  borderRight: "1px solid var(--ezy-border-subtle)",
                  backgroundColor: isActive ? "var(--ezy-bg)" : "transparent",
                  borderBottom: isActive ? "2px solid var(--ezy-accent)" : "2px solid transparent",
                  transition: "background-color 100ms ease",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)";
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                {getFileIcon(fp)}
                <span
                  className="text-[11px] whitespace-nowrap"
                  style={{
                    color: isActive ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
                    fontWeight: isActive ? 500 : 400,
                  }}
                >
                  {name}
                </span>
                {/* Close tab button */}
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                  style={{ color: "var(--ezy-text-muted)" }}
                  onClick={(e) => handleCloseTab(fp, e)}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ezy-red)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")}
                >
                  <path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </div>
            );
          })}
        </div>

        {/* Right side: language badge + save + close pane */}
        <div className="flex items-center gap-1.5 px-2 shrink-0">
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
          {modified && (
            <span className="text-[10px]" style={{ color: "var(--ezy-accent)" }}>
              modified
            </span>
          )}
          {saving && (
            <span className="text-[10px]" style={{ color: "var(--ezy-text-muted)" }}>
              Saving...
            </span>
          )}
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.3"
            strokeLinecap="round"
            className="cursor-pointer hover:opacity-80"
            style={{ opacity: modified ? 1 : 0.4 }}
            onClick={handleSave}
          >
            <path d="M3 14V2h8l2 2v10H3z" />
            <path d="M5 2v4h5V2" />
            <path d="M5 14v-4h6v4" />
          </svg>
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            className="cursor-pointer"
            style={{ color: "var(--ezy-text-muted)" }}
            onClick={onClose}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ezy-red)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")}
          >
            <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      {/* Editor content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: "var(--ezy-text-muted)", fontSize: 13 }}
          >
            Loading {fileName}...
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

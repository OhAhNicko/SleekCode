import { useState } from "react";
import { useAppStore } from "../store";
import { interpolateVariables, type Snippet, type SnippetVariable } from "../store/snippetSlice";
import { getPtyWrite, getAllPtyWriteTerminalIds } from "../store/terminalSlice";
import SnippetEditor from "./SnippetEditor";

interface SnippetPanelProps {
  onClose: () => void;
}

export default function SnippetPanel({ onClose }: SnippetPanelProps) {
  const snippets = useAppStore((s) => s.snippets);
  const addSnippet = useAppStore((s) => s.addSnippet);
  const updateSnippet = useAppStore((s) => s.updateSnippet);
  const removeSnippet = useAppStore((s) => s.removeSnippet);

  const [showEditor, setShowEditor] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | undefined>();
  const [runningSnippet, setRunningSnippet] = useState<Snippet | null>(null);
  const [varValues, setVarValues] = useState<Record<string, string>>({});

  const handleCreate = (data: { name: string; description: string; commands: string[]; variables: SnippetVariable[] }) => {
    addSnippet(data);
    setShowEditor(false);
    setEditingSnippet(undefined);
  };

  const handleUpdate = (data: { name: string; description: string; commands: string[]; variables: SnippetVariable[] }) => {
    if (!editingSnippet) return;
    updateSnippet(editingSnippet.id, data);
    setShowEditor(false);
    setEditingSnippet(undefined);
  };

  const handleRunStart = (snippet: Snippet) => {
    if (snippet.variables.length === 0) {
      executeSnippet(snippet, {});
    } else {
      // Show variable fill dialog
      const defaults: Record<string, string> = {};
      for (const v of snippet.variables) defaults[v.name] = v.defaultValue;
      setVarValues(defaults);
      setRunningSnippet(snippet);
    }
  };

  const handleRunConfirm = () => {
    if (!runningSnippet) return;
    executeSnippet(runningSnippet, varValues);
    setRunningSnippet(null);
    setVarValues({});
  };

  const executeSnippet = (snippet: Snippet, values: Record<string, string>) => {
    // Find the first available PTY write callback (active terminal)
    const allTerminalIds = getAllPtyWriteTerminalIds();
    // Prefer shell terminals
    const terminals = useAppStore.getState().terminals;
    const shellTerminal = allTerminalIds.find((id) => terminals[id]?.type === "shell");
    const targetId = shellTerminal ?? allTerminalIds[0];
    if (!targetId) return;

    const writeFn = getPtyWrite(targetId);
    if (!writeFn) return;

    for (const cmd of snippet.commands) {
      const interpolated = interpolateVariables(cmd, values);
      writeFn(interpolated + "\n");
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "6px 10px",
    backgroundColor: "var(--ezy-bg)",
    border: "1px solid var(--ezy-border)",
    borderRadius: 6,
    color: "var(--ezy-text)",
    fontSize: 13,
    fontFamily: "inherit",
    outline: "none",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0,0,0,0.5)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 480,
          maxHeight: "70vh",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: "1px solid var(--ezy-border)",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ezy-text)" }}>
            Snippets
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => { setEditingSnippet(undefined); setShowEditor(true); }}
              style={{
                padding: "4px 12px",
                backgroundColor: "var(--ezy-accent)",
                border: "none",
                borderRadius: 6,
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              + New
            </button>
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--ezy-text-muted)"
              strokeWidth="1.5"
              strokeLinecap="round"
              style={{ cursor: "pointer" }}
              onClick={onClose}
            >
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </div>
        </div>

        {/* Content */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {/* Variable fill dialog */}
          {runningSnippet && (
            <div style={{ padding: 16, borderBottom: "1px solid var(--ezy-border)" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)", marginBottom: 8 }}>
                Fill variables for: {runningSnippet.name}
              </div>
              {runningSnippet.variables.map((v) => (
                <div key={v.name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ezy-accent)", minWidth: 100 }}>
                    ${v.name}
                  </span>
                  <input
                    value={varValues[v.name] ?? ""}
                    onChange={(e) => setVarValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
                    style={{ ...inputStyle, flex: 1 }}
                    placeholder={v.description ?? v.name}
                  />
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                <button
                  onClick={() => setRunningSnippet(null)}
                  style={{
                    padding: "4px 12px",
                    backgroundColor: "transparent",
                    border: "1px solid var(--ezy-border)",
                    borderRadius: 6,
                    color: "var(--ezy-text-secondary)",
                    fontSize: 12,
                    fontFamily: "inherit",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleRunConfirm}
                  style={{
                    padding: "4px 12px",
                    backgroundColor: "var(--ezy-accent)",
                    border: "none",
                    borderRadius: 6,
                    color: "#fff",
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    cursor: "pointer",
                  }}
                >
                  Run
                </button>
              </div>
            </div>
          )}

          {/* Editor */}
          {showEditor && (
            <SnippetEditor
              snippet={editingSnippet}
              onSave={editingSnippet ? handleUpdate : handleCreate}
              onCancel={() => { setShowEditor(false); setEditingSnippet(undefined); }}
            />
          )}

          {/* Snippet list */}
          {!showEditor && snippets.length === 0 && !runningSnippet && (
            <div style={{ padding: "32px 16px", textAlign: "center", fontSize: 13, color: "var(--ezy-text-muted)" }}>
              No snippets yet. Create one to save reusable command sequences.
            </div>
          )}

          {!showEditor && snippets.map((snippet) => (
            <div
              key={snippet.id}
              style={{
                padding: "10px 16px",
                borderBottom: "1px solid var(--ezy-border-subtle)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>
                  {snippet.name}
                </div>
                {snippet.description && (
                  <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginTop: 2 }}>
                    {snippet.description}
                  </div>
                )}
                <div style={{ fontSize: 10, color: "var(--ezy-text-muted)", marginTop: 4, fontFamily: "'Hack', 'Geist Mono', monospace" }}>
                  {snippet.commands.slice(0, 2).join(" && ")}
                  {snippet.commands.length > 2 && " ..."}
                </div>
              </div>
              <div style={{ display: "flex", gap: 4, flexShrink: 0, marginLeft: 8 }}>
                {/* Run */}
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="var(--ezy-accent)"
                  style={{ cursor: "pointer" }}
                  onClick={() => handleRunStart(snippet)}
                >
                  <path d="M4 2.5v11l9-5.5z" />
                </svg>
                {/* Edit */}
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="var(--ezy-text-muted)"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  style={{ cursor: "pointer" }}
                  onClick={() => { setEditingSnippet(snippet); setShowEditor(true); }}
                >
                  <path d="M11.5 1.5l3 3-9 9H2.5v-3z" />
                </svg>
                {/* Delete */}
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="var(--ezy-text-muted)"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  style={{ cursor: "pointer" }}
                  onClick={() => removeSnippet(snippet.id)}
                >
                  <line x1="4" y1="4" x2="12" y2="12" />
                  <line x1="12" y1="4" x2="4" y2="12" />
                </svg>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

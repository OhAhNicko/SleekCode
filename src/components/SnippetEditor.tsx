import { useState, useEffect } from "react";
import { detectVariables, type Snippet, type SnippetVariable } from "../store/snippetSlice";

interface SnippetEditorProps {
  snippet?: Snippet;
  onSave: (data: { name: string; description: string; commands: string[]; variables: SnippetVariable[] }) => void;
  onCancel: () => void;
}

export default function SnippetEditor({ snippet, onSave, onCancel }: SnippetEditorProps) {
  const [name, setName] = useState(snippet?.name ?? "");
  const [description, setDescription] = useState(snippet?.description ?? "");
  const [commandsText, setCommandsText] = useState(snippet?.commands.join("\n") ?? "");
  const [variables, setVariables] = useState<SnippetVariable[]>(snippet?.variables ?? []);

  // Auto-detect variables when commands change
  useEffect(() => {
    const commands = commandsText.split("\n").filter((l) => l.trim());
    const detected = detectVariables(commands);
    // Merge with existing variables to preserve user-set defaults
    setVariables((prev) => {
      const existing = new Map(prev.map((v) => [v.name, v]));
      return detected.map((d) => existing.get(d.name) ?? d);
    });
  }, [commandsText]);

  const handleSubmit = () => {
    if (!name.trim()) return;
    const commands = commandsText.split("\n").filter((l) => l.trim());
    if (commands.length === 0) return;
    onSave({ name: name.trim(), description: description.trim(), commands, variables });
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
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 16,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ezy-text)" }}>
        {snippet ? "Edit Snippet" : "New Snippet"}
      </div>

      <div>
        <label style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 4, display: "block" }}>
          Name
        </label>
        <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} placeholder="e.g. Deploy to staging" />
      </div>

      <div>
        <label style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 4, display: "block" }}>
          Description
        </label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} placeholder="Optional description" />
      </div>

      <div>
        <label style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 4, display: "block" }}>
          Commands (one per line, use $VAR_NAME for variables)
        </label>
        <textarea
          value={commandsText}
          onChange={(e) => setCommandsText(e.target.value)}
          rows={5}
          style={{
            ...inputStyle,
            resize: "vertical",
            fontFamily: "'Geist Mono', 'Cascadia Code', monospace",
          }}
          placeholder={"git checkout $BRANCH_NAME\nnpm install\nnpm run dev -- --port $PORT"}
        />
      </div>

      {variables.length > 0 && (
        <div>
          <label style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 4, display: "block" }}>
            Detected Variables
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {variables.map((v, i) => (
              <div key={v.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--ezy-accent)",
                    minWidth: 100,
                  }}
                >
                  ${v.name}
                </span>
                <input
                  value={v.defaultValue}
                  onChange={(e) => {
                    const updated = [...variables];
                    updated[i] = { ...v, defaultValue: e.target.value };
                    setVariables(updated);
                  }}
                  style={{ ...inputStyle, flex: 1 }}
                  placeholder="Default value"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
        <button
          onClick={onCancel}
          style={{
            padding: "6px 16px",
            backgroundColor: "transparent",
            border: "1px solid var(--ezy-border)",
            borderRadius: 6,
            color: "var(--ezy-text-secondary)",
            fontSize: 13,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          style={{
            padding: "6px 16px",
            backgroundColor: "var(--ezy-accent)",
            border: "none",
            borderRadius: 6,
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          {snippet ? "Update" : "Create"}
        </button>
      </div>
    </div>
  );
}

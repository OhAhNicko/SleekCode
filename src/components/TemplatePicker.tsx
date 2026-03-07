import { useState, useCallback, useRef } from "react";
import { WORKSPACE_TEMPLATES, type WorkspaceTemplate } from "../lib/workspace-templates";
import { useAppStore } from "../store";
import { getServerCommandSuggestions, BUILTIN_SERVER_COMMANDS } from "../lib/server-commands";
import type { TerminalType } from "../types";

interface TemplatePickerProps {
  onSelect: (template: WorkspaceTemplate, slotTypes: TerminalType[], serverCommand?: string) => void;
  onClose: () => void;
  initialServerCommand?: string;
}

function GridPreview({ template }: { template: WorkspaceTemplate }) {
  const { cols, rows, id } = template;

  // Special rendering for main-side
  if (id === "main-side") {
    return (
      <div style={{ display: "flex", gap: 2, width: 64, height: 44 }}>
        <div
          style={{
            flex: 3,
            borderRadius: 2,
            backgroundColor: "var(--ezy-border)",
          }}
        />
        <div style={{ flex: 2, display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ flex: 1, borderRadius: 2, backgroundColor: "var(--ezy-border)" }} />
          <div style={{ flex: 1, borderRadius: 2, backgroundColor: "var(--ezy-border)" }} />
        </div>
      </div>
    );
  }

  const cells: React.ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push(
        <div
          key={`${r}-${c}`}
          style={{
            borderRadius: 2,
            backgroundColor: "var(--ezy-border)",
          }}
        />
      );
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        gap: 2,
        width: 64,
        height: 44,
      }}
    >
      {cells}
    </div>
  );
}

const TERMINAL_OPTIONS: { type: TerminalType; label: string }[] = [
  { type: "claude", label: "Claude" },
  { type: "codex", label: "Codex" },
  { type: "gemini", label: "Gemini" },
  { type: "shell", label: "Shell" },
];


export default function TemplatePicker({ onSelect, onClose, initialServerCommand }: TemplatePickerProps) {
  const claudeYolo = useAppStore((s) => s.claudeYolo);
  const addCustomServerCommand = useAppStore((s) => s.addCustomServerCommand);
  const removeCustomServerCommand = useAppStore((s) => s.removeCustomServerCommand);
  const [selectedTemplate, setSelectedTemplate] = useState<WorkspaceTemplate | null>(null);
  const [slotTypes, setSlotTypes] = useState<TerminalType[]>([]);
  const [serverCommand, setServerCommand] = useState(initialServerCommand ?? "");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const cmdInputRef = useRef<HTMLInputElement>(null);

  const suggestions = getServerCommandSuggestions(serverCommand.trim() || undefined);

  const handleTemplateSelect = useCallback((template: WorkspaceTemplate) => {
    setSelectedTemplate(template);
    const slotCount = template.id === "main-side" ? 3 : template.cols * template.rows;
    setSlotTypes(Array(slotCount).fill("claude" as TerminalType));
  }, []);

  const handleSlotChange = useCallback((index: number, type: TerminalType) => {
    setSlotTypes((prev) => {
      const next = [...prev];
      next[index] = type;
      return next;
    });
  }, []);

  const handleCreate = useCallback(() => {
    if (selectedTemplate) {
      if (serverCommand && !BUILTIN_SERVER_COMMANDS.includes(serverCommand.trim())) {
        addCustomServerCommand(serverCommand.trim());
      }
      onSelect(selectedTemplate, slotTypes, serverCommand || undefined);
    }
  }, [selectedTemplate, slotTypes, onSelect, serverCommand, addCustomServerCommand]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
        zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        style={{
          maxWidth: 448,
          width: "100%",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 10,
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            height: 32,
            padding: "0 16px",
            borderBottom: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>
            New Workspace
          </span>
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

        {/* Server Command combobox */}
        <div style={{ padding: "12px 16px 0", position: "relative" }}>
          <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 4, fontWeight: 500 }}>
            Server Command (optional)
          </div>
          <div style={{ position: "relative" }}>
            <input
              ref={cmdInputRef}
              type="text"
              value={serverCommand}
              onChange={(e) => {
                setServerCommand(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="e.g. npm run dev"
              style={{
                width: "100%",
                padding: "6px 28px 6px 10px",
                backgroundColor: "var(--ezy-bg)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 6,
                color: "var(--ezy-text)",
                fontSize: 12,
                fontFamily: "inherit",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="var(--ezy-text-muted)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                position: "absolute",
                right: 8,
                top: "50%",
                transform: "translateY(-50%)",
                cursor: "pointer",
              }}
              onClick={() => {
                setShowSuggestions((v) => !v);
                cmdInputRef.current?.focus();
              }}
            >
              <polyline points="2,4 6,8 10,4" />
            </svg>
            {showSuggestions && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 2px)",
                  left: 0,
                  right: 0,
                  backgroundColor: "var(--ezy-surface-raised)",
                  border: "1px solid var(--ezy-border)",
                  borderRadius: 6,
                  overflow: "hidden",
                  zIndex: 10,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                }}
              >
                {suggestions.map(({ command: cmd, isCustom }) => (
                    <div
                      key={cmd}
                      style={{
                        padding: "6px 10px",
                        fontSize: 12,
                        color: "var(--ezy-text-secondary)",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setServerCommand(cmd);
                        setShowSuggestions(false);
                      }}
                    >
                      <span>{cmd}</span>
                      {isCustom && (
                        <svg
                          width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" strokeLinecap="round"
                          className="devserver-cmd-remove"
                          style={{ flexShrink: 0, opacity: 0, transition: "opacity 100ms ease", cursor: "pointer" }}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            removeCustomServerCommand(cmd);
                          }}
                        >
                          <line x1="2" y1="2" x2="8" y2="8" />
                          <line x1="8" y1="2" x2="2" y2="8" />
                        </svg>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>

        {/* Layout selection — always visible */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 8,
            padding: 16,
            paddingBottom: selectedTemplate ? 8 : 16,
          }}
        >
          {WORKSPACE_TEMPLATES.map((template) => {
            const isSelected = selectedTemplate?.id === template.id;
            return (
              <button
                key={template.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  padding: "12px 8px",
                  backgroundColor: isSelected ? "var(--ezy-accent-glow)" : "transparent",
                  border: `1px solid ${isSelected ? "var(--ezy-accent)" : "var(--ezy-border)"}`,
                  borderRadius: 8,
                  cursor: "pointer",
                  transition: "all 150ms ease",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.borderColor = "var(--ezy-accent)";
                    e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.borderColor = "var(--ezy-border)";
                    e.currentTarget.style.backgroundColor = "transparent";
                  }
                }}
                onClick={() => handleTemplateSelect(template)}
              >
                <GridPreview template={template} />
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ezy-text)" }}>
                  {template.name}
                </span>
                <span style={{ fontSize: 10, color: "var(--ezy-text-muted)" }}>
                  {template.description}
                </span>
              </button>
            );
          })}
        </div>

        {/* Agent assignment — appears when a template is selected */}
        {selectedTemplate && (
          <div style={{ padding: "0 16px 16px" }}>
            <div style={{ marginBottom: 8, fontSize: 11, color: "var(--ezy-text-muted)", fontWeight: 500 }}>
              Assign agent per pane:
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {slotTypes.map((type, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "5px 10px",
                    backgroundColor: "var(--ezy-surface)",
                    borderRadius: 6,
                    border: "1px solid var(--ezy-border)",
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: "var(--ezy-text-muted)",
                      minWidth: 48,
                    }}
                  >
                    Pane {i + 1}
                  </span>
                  <select
                    value={type}
                    onChange={(e) => handleSlotChange(i, e.target.value as TerminalType)}
                    style={{
                      flex: 1,
                      padding: "4px 8px",
                      backgroundColor: "var(--ezy-bg)",
                      border: "1px solid var(--ezy-border)",
                      borderRadius: 4,
                      color: "var(--ezy-text)",
                      fontSize: 12,
                      fontFamily: "inherit",
                      cursor: "pointer",
                      outline: "none",
                    }}
                  >
                    {TERMINAL_OPTIONS.map((opt) => (
                      <option key={opt.type} value={opt.type}>
                        {opt.label}{opt.type === "claude" && claudeYolo ? " (YOLO)" : ""}
                      </option>
                    ))}
                  </select>
                  {type === "claude" && claudeYolo && (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        lineHeight: 1,
                        padding: "1px 4px",
                        borderRadius: 3,
                        backgroundColor: "var(--ezy-red, #e55)",
                        color: "#fff",
                        flexShrink: 0,
                      }}
                    >
                      YOLO
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* Create button */}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button
                onClick={handleCreate}
                style={{
                  padding: "6px 16px",
                  backgroundColor: "var(--ezy-accent-dim)",
                  border: "none",
                  borderRadius: 6,
                  color: "#ffffff",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Create Workspace
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

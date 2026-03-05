import { useState, useCallback } from "react";
import { WORKSPACE_TEMPLATES, type WorkspaceTemplate } from "../lib/workspace-templates";
import type { TerminalType } from "../types";

interface TemplatePickerProps {
  onSelect: (template: WorkspaceTemplate, slotTypes: TerminalType[]) => void;
  onClose: () => void;
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
  { type: "shell", label: "Shell" },
  { type: "claude", label: "Claude" },
  { type: "codex", label: "Codex" },
  { type: "gemini", label: "Gemini" },
];

export default function TemplatePicker({ onSelect, onClose }: TemplatePickerProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedTemplate, setSelectedTemplate] = useState<WorkspaceTemplate | null>(null);
  const [slotTypes, setSlotTypes] = useState<TerminalType[]>([]);

  const handleTemplateSelect = useCallback((template: WorkspaceTemplate) => {
    setSelectedTemplate(template);
    const slotCount = template.id === "main-side" ? 3 : template.cols * template.rows;
    setSlotTypes(Array(slotCount).fill("shell" as TerminalType));
    // Single pane: skip step 2
    if (slotCount === 1) {
      onSelect(template, ["shell"]);
      return;
    }
    setStep(2);
  }, [onSelect]);

  const handleSlotChange = useCallback((index: number, type: TerminalType) => {
    setSlotTypes((prev) => {
      const next = [...prev];
      next[index] = type;
      return next;
    });
  }, []);

  const handleCreate = useCallback(() => {
    if (selectedTemplate) {
      onSelect(selectedTemplate, slotTypes);
    }
  }, [selectedTemplate, slotTypes, onSelect]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: step === 1 ? 480 : 400,
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
            padding: "12px 16px",
            borderBottom: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>
            {step === 1 ? "Choose Layout" : "Assign Agents"}
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

        {step === 1 ? (
          /* Step 1: Template selection */
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 8,
              padding: 16,
            }}
          >
            {WORKSPACE_TEMPLATES.map((template) => (
              <button
                key={template.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  padding: "12px 8px",
                  backgroundColor: "transparent",
                  border: "1px solid var(--ezy-border)",
                  borderRadius: 8,
                  cursor: "pointer",
                  transition: "all 150ms ease",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--ezy-accent)";
                  e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--ezy-border)";
                  e.currentTarget.style.backgroundColor = "transparent";
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
            ))}
          </div>
        ) : (
          /* Step 2: Assign agent types per slot */
          <div style={{ padding: 16 }}>
            <div style={{ marginBottom: 12, fontSize: 12, color: "var(--ezy-text-muted)" }}>
              Choose an agent type for each pane slot:
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {slotTypes.map((type, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "6px 10px",
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
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button
                onClick={() => setStep(1)}
                style={{
                  padding: "6px 16px",
                  backgroundColor: "transparent",
                  border: "1px solid var(--ezy-border)",
                  borderRadius: 6,
                  color: "var(--ezy-text-muted)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Back
              </button>
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

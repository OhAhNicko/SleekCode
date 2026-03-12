import { useState, useCallback, useRef, useMemo } from "react";
import { WORKSPACE_TEMPLATES, type WorkspaceTemplate } from "../lib/workspace-templates";
import { useAppStore } from "../store";
import { getServerCommandSuggestions, BUILTIN_SERVER_COMMANDS } from "../lib/server-commands";
import type { TerminalType } from "../types";

export type ExtraPaneType = "codereview" | "fileviewer" | "browser" | "kanban";

interface TemplatePickerProps {
  onSelect: (template: WorkspaceTemplate, slotTypes: TerminalType[], serverCommand?: string, extraPanes?: ExtraPaneType[]) => void;
  onClose: () => void;
  initialServerCommand?: string;
}

/** Distribute `count` panes across `cols` columns (taller columns first). */
function distributePreviewColumns(count: number, cols: number): number[] {
  if (cols <= 0) return [count];
  const base = Math.floor(count / cols);
  const remainder = count % cols;
  return Array.from({ length: cols }, (_, i) => base + (i < remainder ? 1 : 0));
}

function GridPreview({ template }: { template: WorkspaceTemplate }) {
  const { cols, paneCount } = template;
  const colHeights = distributePreviewColumns(paneCount, cols);

  return (
    <div style={{ display: "flex", gap: 2, width: 64, height: 44 }}>
      {colHeights.map((rowCount, c) => (
        <div key={c} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          {Array.from({ length: rowCount }, (_, r) => (
            <div key={r} style={{ flex: 1, borderRadius: 2, backgroundColor: "var(--ezy-border)" }} />
          ))}
        </div>
      ))}
    </div>
  );
}

const FLEET_AGENTS: { type: TerminalType; label: string; description: string }[] = [
  { type: "claude", label: "Claude", description: "claude code" },
  { type: "codex", label: "Codex", description: "codex cli" },
  { type: "gemini", label: "Gemini", description: "gemini cli" },
];

const EXTRA_PANES: { type: ExtraPaneType; label: string; description: string }[] = [
  { type: "codereview", label: "Code Review", description: "Git diff viewer" },
  { type: "browser", label: "Browser Preview", description: "Built-in web preview" },
  { type: "kanban", label: "Tasks", description: "Kanban task board" },
];

type FleetCounts = Record<string, number>;

function expandFleetToSlots(counts: FleetCounts): TerminalType[] {
  const result: TerminalType[] = [];
  for (const agent of FLEET_AGENTS) {
    for (let i = 0; i < (counts[agent.type] ?? 0); i++) {
      result.push(agent.type);
    }
  }
  return result;
}

function makeAllClaude(slotCount: number): FleetCounts {
  return { claude: slotCount, codex: 0, gemini: 0 };
}

function makeEvenFleet(slotCount: number): FleetCounts {
  const agentCount = FLEET_AGENTS.length;
  const base = Math.floor(slotCount / agentCount);
  const remainder = slotCount % agentCount;
  const counts: FleetCounts = {};
  FLEET_AGENTS.forEach((agent, i) => {
    counts[agent.type] = base + (i < remainder ? 1 : 0);
  });
  return counts;
}

function makeOneEach(slotCount: number): FleetCounts {
  const agentCount = FLEET_AGENTS.length;
  if (slotCount < agentCount) {
    // Not enough slots for all agents — fill what we can starting from first
    const counts: FleetCounts = {};
    FLEET_AGENTS.forEach((agent, i) => {
      counts[agent.type] = i < slotCount ? 1 : 0;
    });
    return counts;
  }
  const counts: FleetCounts = {};
  FLEET_AGENTS.forEach((agent) => {
    counts[agent.type] = 1;
  });
  // Fill remainder with Claude
  counts["claude"] += slotCount - agentCount;
  return counts;
}

function SlotAllocation({ assigned, total }: { assigned: number; total: number }) {
  const pct = total > 0 ? (assigned / total) * 100 : 0;
  const isFull = assigned === total && total > 0;

  return (
    <div
      style={{
        backgroundColor: "var(--ezy-surface)",
        border: "1px solid var(--ezy-border)",
        borderRadius: 8,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minWidth: 160,
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: "0.1em",
          color: "var(--ezy-text-muted)",
          textTransform: "uppercase",
        }}
      >
        Slot Allocation
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: "var(--ezy-text)", lineHeight: 1 }}>
          {assigned}
        </span>
        <span style={{ fontSize: 12, color: "var(--ezy-text-muted)" }}>
          / {total} slots
        </span>
      </div>

      {/* Progress bar */}
      <div
        style={{
          height: 6,
          backgroundColor: "var(--ezy-border)",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            backgroundColor: isFull ? "var(--ezy-accent)" : "var(--ezy-accent-dim)",
            borderRadius: 3,
            transition: "width 200ms ease, background-color 200ms ease",
          }}
        />
      </div>

      {/* Status indicator */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: isFull ? "var(--ezy-accent)" : "var(--ezy-text-muted)",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 11,
            color: isFull ? "var(--ezy-accent)" : "var(--ezy-text-muted)",
            fontWeight: 500,
          }}
        >
          {isFull ? "All slots assigned" : `${total - assigned} slot${total - assigned !== 1 ? "s" : ""} remaining`}
        </span>
      </div>
    </div>
  );
}


export default function TemplatePicker({ onSelect, onClose, initialServerCommand }: TemplatePickerProps) {
  const cliYolo = useAppStore((s) => s.cliYolo);
  const addCustomServerCommand = useAppStore((s) => s.addCustomServerCommand);
  const removeCustomServerCommand = useAppStore((s) => s.removeCustomServerCommand);
  const [selectedTemplate, setSelectedTemplate] = useState<WorkspaceTemplate | null>(null);
  const [fleetCounts, setFleetCounts] = useState<FleetCounts>({});
  const [extraPanes, setExtraPanes] = useState<Set<ExtraPaneType>>(new Set());
  const [serverCommand, setServerCommand] = useState(initialServerCommand ?? "");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const cmdInputRef = useRef<HTMLInputElement>(null);

  const suggestions = getServerCommandSuggestions(serverCommand.trim() || undefined);

  const slotCount = useMemo(() => {
    if (!selectedTemplate) return 0;
    return selectedTemplate.paneCount;
  }, [selectedTemplate]);

  const totalAssigned = useMemo(() => {
    return Object.values(fleetCounts).reduce((sum, c) => sum + c, 0);
  }, [fleetCounts]);

  const handleTemplateSelect = useCallback((template: WorkspaceTemplate) => {
    setSelectedTemplate(template);
    const newSlotCount = template.paneCount;
    setFleetCounts((prev) => {
      const prevTotal = Object.values(prev).reduce((s, c) => s + c, 0);
      if (prevTotal === 0) return prev; // no prior choices — stay empty
      // Clamp if new layout has fewer slots
      if (prevTotal <= newSlotCount) return prev;
      // Trim from the end of the agent list until we fit
      const clamped = { ...prev };
      let excess = prevTotal - newSlotCount;
      for (let i = FLEET_AGENTS.length - 1; i >= 0 && excess > 0; i--) {
        const key = FLEET_AGENTS[i].type;
        const reduce = Math.min(clamped[key] ?? 0, excess);
        clamped[key] = (clamped[key] ?? 0) - reduce;
        excess -= reduce;
      }
      return clamped;
    });
  }, []);

  const handleIncrement = useCallback((agentType: string) => {
    setFleetCounts((prev) => {
      const currentTotal = Object.values(prev).reduce((s, c) => s + c, 0);
      if (currentTotal >= slotCount) return prev;
      return { ...prev, [agentType]: (prev[agentType] ?? 0) + 1 };
    });
  }, [slotCount]);

  const handleDecrement = useCallback((agentType: string) => {
    setFleetCounts((prev) => {
      const current = prev[agentType] ?? 0;
      if (current <= 0) return prev;
      return { ...prev, [agentType]: current - 1 };
    });
  }, []);

  const handleToggle = useCallback((agentType: string) => {
    setFleetCounts((prev) => {
      const current = prev[agentType] ?? 0;
      if (current > 0) {
        // Toggling off
        return { ...prev, [agentType]: 0 };
      }
      // Toggling on — add 1 if slots available
      const currentTotal = Object.values(prev).reduce((s, c) => s + c, 0);
      if (currentTotal >= slotCount) return prev;
      return { ...prev, [agentType]: 1 };
    });
  }, [slotCount]);

  const handleCreate = useCallback(() => {
    if (selectedTemplate) {
      if (serverCommand && !BUILTIN_SERVER_COMMANDS.includes(serverCommand.trim())) {
        addCustomServerCommand(serverCommand.trim());
      }
      const slots = expandFleetToSlots(fleetCounts);
      const extras = extraPanes.size > 0 ? Array.from(extraPanes) : undefined;
      onSelect(selectedTemplate, slots, serverCommand || undefined, extras);
    }
  }, [selectedTemplate, fleetCounts, extraPanes, onSelect, serverCommand, addCustomServerCommand]);

  const canLaunch = selectedTemplate && totalAssigned === slotCount;

  const quickActionStyle: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.04em",
    color: "var(--ezy-text-secondary)",
    backgroundColor: "transparent",
    border: "1px solid var(--ezy-border)",
    borderRadius: 100,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "all 120ms ease",
    whiteSpace: "nowrap",
  };

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
          maxWidth: 560,
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
            const isDisabledByKanban = extraPanes.has("kanban") && template.rows >= 4;
            return (
              <button
                key={template.id}
                disabled={isDisabledByKanban}
                title={isDisabledByKanban ? "Max 3 rows when Kanban is enabled" : undefined}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  padding: "12px 8px",
                  backgroundColor: isSelected ? "var(--ezy-accent-glow)" : "transparent",
                  border: `1px solid ${isSelected ? "var(--ezy-accent)" : "var(--ezy-border)"}`,
                  borderRadius: 8,
                  cursor: isDisabledByKanban ? "not-allowed" : "pointer",
                  transition: "all 150ms ease",
                  fontFamily: "inherit",
                  opacity: isDisabledByKanban ? 0.35 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!isSelected && !isDisabledByKanban) {
                    e.currentTarget.style.borderColor = "var(--ezy-accent)";
                    e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected && !isDisabledByKanban) {
                    e.currentTarget.style.borderColor = "var(--ezy-border)";
                    e.currentTarget.style.backgroundColor = "transparent";
                  }
                }}
                onClick={() => !isDisabledByKanban && handleTemplateSelect(template)}
              >
                <GridPreview template={template} />
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ezy-text)" }}>
                  {template.name}
                </span>
              </button>
            );
          })}
        </div>

        {/* Agent assignment — appears when a template is selected */}
        {selectedTemplate && (
          <div style={{ padding: "0 16px 16px" }}>
            {/* Section header */}
            <div style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ezy-text)" }}>
                Assign Agents
              </div>
              <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginTop: 2 }}>
                Choose agents for your {slotCount} terminal slot{slotCount !== 1 ? "s" : ""}.
              </div>
            </div>

            {/* Quick action buttons */}
            <div style={{ display: "flex", gap: 6, marginBottom: 12, marginTop: 10, flexWrap: "wrap" }}>
              <button
                style={quickActionStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--ezy-accent)";
                  e.currentTarget.style.color = "var(--ezy-text)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--ezy-border)";
                  e.currentTarget.style.color = "var(--ezy-text-secondary)";
                }}
                onClick={() => setFleetCounts(makeAllClaude(slotCount))}
              >
                SELECT ALL
              </button>
              <button
                style={quickActionStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--ezy-accent)";
                  e.currentTarget.style.color = "var(--ezy-text)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--ezy-border)";
                  e.currentTarget.style.color = "var(--ezy-text-secondary)";
                }}
                onClick={() => setFleetCounts(makeOneEach(slotCount))}
              >
                1 EACH
              </button>
              <button
                style={quickActionStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--ezy-accent)";
                  e.currentTarget.style.color = "var(--ezy-text)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--ezy-border)";
                  e.currentTarget.style.color = "var(--ezy-text-secondary)";
                }}
                onClick={() => setFleetCounts(makeEvenFleet(slotCount))}
              >
                FILL EVENLY
              </button>
              <button
                style={quickActionStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--ezy-red)";
                  e.currentTarget.style.color = "var(--ezy-text)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--ezy-border)";
                  e.currentTarget.style.color = "var(--ezy-text-secondary)";
                }}
                onClick={() => setFleetCounts({ claude: 0, codex: 0, gemini: 0 })}
              >
                CLEAR
              </button>
            </div>

            {/* Agent config — two-column layout */}
            <div style={{ display: "flex", gap: 12 }}>
              {/* Agent list */}
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  border: "1px solid var(--ezy-border)",
                  borderRadius: 8,
                  overflow: "hidden",
                }}
              >
                {FLEET_AGENTS.map((agent, i) => {
                  const count = fleetCounts[agent.type] ?? 0;
                  const isActive = count > 0;
                  const currentTotal = Object.values(fleetCounts).reduce((s, c) => s + c, 0);
                  const canIncrement = currentTotal < slotCount;

                  return (
                    <div
                      key={agent.type}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 12px",
                        backgroundColor: "var(--ezy-surface)",
                        borderBottom: i < FLEET_AGENTS.length - 1 ? "1px solid var(--ezy-border)" : "none",
                      }}
                    >
                      {/* Checkbox */}
                      <div
                        onClick={() => handleToggle(agent.type)}
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 3,
                          border: `1.5px solid ${isActive ? "var(--ezy-accent)" : "var(--ezy-border-light)"}`,
                          backgroundColor: isActive ? "var(--ezy-accent)" : "transparent",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                          flexShrink: 0,
                          transition: "all 120ms ease",
                        }}
                      >
                        {isActive && (
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="2,5.5 4,7.5 8,3" />
                          </svg>
                        )}
                      </div>

                      {/* Agent info */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ezy-text)" }}>
                          {agent.label}
                          {!!cliYolo[agent.type] && (
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
                                marginLeft: 6,
                                verticalAlign: "middle",
                              }}
                            >
                              YOLO
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 10, color: "var(--ezy-text-muted)", marginTop: 1 }}>
                          {agent.description}
                        </div>
                      </div>

                      {/* Stepper */}
                      <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                        <button
                          onClick={() => handleDecrement(agent.type)}
                          disabled={count <= 0}
                          style={{
                            width: 22,
                            height: 22,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: count > 0 ? "var(--ezy-border)" : "transparent",
                            border: `1px solid ${count > 0 ? "var(--ezy-border-light)" : "var(--ezy-border)"}`,
                            borderRadius: 4,
                            color: count > 0 ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                            fontSize: 14,
                            fontWeight: 600,
                            cursor: count > 0 ? "pointer" : "default",
                            fontFamily: "inherit",
                            lineHeight: 1,
                            padding: 0,
                            opacity: count > 0 ? 1 : 0.4,
                            transition: "all 120ms ease",
                          }}
                        >
                          -
                        </button>
                        <span
                          style={{
                            width: 24,
                            textAlign: "center",
                            fontSize: 13,
                            fontWeight: 700,
                            color: isActive ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {count}
                        </span>
                        <button
                          onClick={() => handleIncrement(agent.type)}
                          disabled={!canIncrement}
                          style={{
                            width: 22,
                            height: 22,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: canIncrement ? "var(--ezy-border)" : "transparent",
                            border: `1px solid ${canIncrement ? "var(--ezy-border-light)" : "var(--ezy-border)"}`,
                            borderRadius: 4,
                            color: canIncrement ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                            fontSize: 14,
                            fontWeight: 600,
                            cursor: canIncrement ? "pointer" : "default",
                            fontFamily: "inherit",
                            lineHeight: 1,
                            padding: 0,
                            opacity: canIncrement ? 1 : 0.4,
                            transition: "all 120ms ease",
                          }}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Slot allocation panel */}
              <SlotAllocation assigned={totalAssigned} total={slotCount} />
            </div>

            {/* Extra panes */}
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ezy-text-muted)", marginBottom: 8 }}>
                Additional Panes (optional)
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {EXTRA_PANES.map((pane) => {
                  const isOn = extraPanes.has(pane.type);
                  return (
                    <button
                      key={pane.type}
                      onClick={() => {
                        setExtraPanes((prev) => {
                          const next = new Set(prev);
                          if (next.has(pane.type)) next.delete(pane.type);
                          else next.add(pane.type);
                          // If kanban was just enabled, deselect any 4-row template
                          if (pane.type === "kanban" && next.has("kanban") && selectedTemplate && selectedTemplate.rows >= 4) {
                            setSelectedTemplate(null);
                            setFleetCounts({});
                          }
                          return next;
                        });
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        flex: 1,
                        gap: 5,
                        padding: "6px 6px",
                        backgroundColor: isOn ? "var(--ezy-accent-glow)" : "var(--ezy-surface)",
                        border: `1px solid ${isOn ? "var(--ezy-accent)" : "var(--ezy-border)"}`,
                        borderRadius: 6,
                        cursor: "pointer",
                        fontFamily: "inherit",
                        transition: "all 120ms ease",
                      }}
                      onMouseEnter={(e) => {
                        if (!isOn) {
                          e.currentTarget.style.borderColor = "var(--ezy-accent)";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isOn) {
                          e.currentTarget.style.borderColor = "var(--ezy-border)";
                        }
                      }}
                    >
                      {/* Mini checkbox */}
                      <div
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 3,
                          border: `1.5px solid ${isOn ? "var(--ezy-accent)" : "var(--ezy-border-light)"}`,
                          backgroundColor: isOn ? "var(--ezy-accent)" : "transparent",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                          transition: "all 120ms ease",
                        }}
                      >
                        {isOn && (
                          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="2,5.5 4,7.5 8,3" />
                          </svg>
                        )}
                      </div>
                      <span style={{ fontSize: 10, fontWeight: 600, color: "var(--ezy-text)", whiteSpace: "nowrap" }}>
                        {pane.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Launch button */}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
              <button
                onClick={handleCreate}
                disabled={!canLaunch}
                style={{
                  padding: "8px 22px",
                  backgroundColor: canLaunch ? "var(--ezy-accent-dim)" : "var(--ezy-border)",
                  border: "none",
                  borderRadius: 6,
                  color: canLaunch ? "#fff" : "var(--ezy-text-muted)",
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                  cursor: canLaunch ? "pointer" : "default",
                  fontFamily: "inherit",
                  transition: "all 150ms ease",
                  opacity: canLaunch ? 1 : 0.5,
                }}
                onMouseEnter={(e) => {
                  if (canLaunch) {
                    e.currentTarget.style.backgroundColor = "var(--ezy-accent-hover)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (canLaunch) {
                    e.currentTarget.style.backgroundColor = "var(--ezy-accent-dim)";
                  }
                }}
              >
                LAUNCH WORKSPACE
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

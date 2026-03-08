import { useState, useEffect } from "react";
import type { TerminalType } from "../types";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";

const TOOL_ORDER: TerminalType[] = ["claude", "codex", "gemini", "shell"];


interface TerminalHeaderProps {
  terminalId: string;
  terminalType: TerminalType;
  isActive: boolean;
  onChangeType: (type: TerminalType) => void;
  onClose: () => void;
  onSwapPane?: (fromTerminalId: string, toTerminalId: string) => void;
  serverName?: string;
  isYolo?: boolean;
}

function TerminalIcon({ type }: { type: TerminalType }) {
  const size = 14;
  switch (type) {
    case "claude":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <path
            d="M8 1L14.93 5.5V12.5L8 15L1.07 12.5V5.5L8 1Z"
            fill="#e6733a"
            stroke="#e6733a"
            strokeWidth="0.5"
          />
          <circle cx="8" cy="8.5" r="2.5" fill="#0d1117" />
        </svg>
      );
    case "codex":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <rect x="2" y="2" width="12" height="12" rx="2" fill="#10a37f" />
          <path
            d="M6 5.5V10.5M10 5.5V10.5M5 8H11"
            stroke="#0d1117"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case "gemini":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" fill="#8e75f0" />
          <path
            d="M8 3C8 3 11 6 11 8C11 10 8 13 8 13C8 13 5 10 5 8C5 6 8 3 8 3Z"
            fill="#0d1117"
          />
        </svg>
      );
    case "shell":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <rect
            x="1.5"
            y="2.5"
            width="13"
            height="11"
            rx="1.5"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1"
          />
          <path
            d="M4.5 6L6.5 8L4.5 10"
            stroke="var(--ezy-accent)"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <line
            x1="8"
            y1="10"
            x2="11"
            y2="10"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

/** Compact CLI picker dropdown used for split and type-switch */
function CliPicker({
  onSelect,
  onClose,
  currentType,
}: {
  onSelect: (type: TerminalType) => void;
  onClose: () => void;
  currentType?: TerminalType;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      {/* Backdrop to catch clicks outside (Tauri drag region swallows mousedown) */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: 199 }}
        onMouseDown={onClose}
      />
      <div
        className="dropdown-enter"
        style={{
          position: "absolute",
          top: "100%",
          left: 0,
          marginTop: 2,
          width: 180,
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
          zIndex: 200,
        }}
      >
      {TOOL_ORDER.map((type) => {
        const config = TERMINAL_CONFIGS[type];
        const isCurrent = type === currentType;
        return (
          <button
            key={type}
            className="w-full text-left"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              backgroundColor: isCurrent ? "var(--ezy-accent-glow)" : "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: isCurrent ? 600 : 400,
              color: isCurrent ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
              fontFamily: "inherit",
            }}
            onMouseEnter={(e) => {
              if (!isCurrent) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
            }}
            onMouseLeave={(e) => {
              if (!isCurrent) e.currentTarget.style.backgroundColor = "transparent";
            }}
            onClick={() => {
              onSelect(type);
              onClose();
            }}
          >
            <TerminalIcon type={type} />
            <span>{config.label}</span>
            {isCurrent && (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-accent)" strokeWidth="2" strokeLinecap="round" style={{ marginLeft: "auto" }}>
                <polyline points="2,8 6,12 14,4" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
    </>
  );
}

export default function TerminalHeader({
  terminalId,
  terminalType,
  isActive,
  onChangeType,
  onClose,
  onSwapPane,
  serverName,
  isYolo = false,
}: TerminalHeaderProps) {
  const config = TERMINAL_CONFIGS[terminalType];
  const [showTypePicker, setShowTypePicker] = useState(false);
  return (
    <div
      className="flex items-center justify-between select-none"
      style={{
        height: 28,
        backgroundColor: isActive ? "var(--ezy-surface-raised)" : "var(--ezy-surface)",
        borderBottom: `1px solid ${isActive ? "var(--ezy-accent)" : "var(--ezy-border)"}`,
        padding: "0 6px 0 0",
        transition: "border-color 200ms ease, background-color 200ms ease",
      }}
    >
      {/* Drag handle — custom pointer drag (HTML5 DnD doesn't work in Tauri WebView2) */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          document.documentElement.classList.add("ezy-dragging-pane");

          // Clear any prior highlights
          document.querySelectorAll("[data-terminal-id]").forEach((el) => {
            (el as HTMLElement).style.outline = "";
          });

          const handleMouseMove = (ev: MouseEvent) => {
            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            const pane = el?.closest("[data-terminal-id]") as HTMLElement | null;
            const hoveredId = pane?.getAttribute("data-terminal-id");

            document.querySelectorAll("[data-terminal-id]").forEach((p) => {
              const pid = p.getAttribute("data-terminal-id");
              (p as HTMLElement).style.outline =
                pid === hoveredId && hoveredId !== terminalId
                  ? "2px solid var(--ezy-accent)"
                  : "";
            });
          };

          const handleMouseUp = (ev: MouseEvent) => {
            document.documentElement.classList.remove("ezy-dragging-pane");
            document.removeEventListener("mousemove", handleMouseMove, true);
            document.removeEventListener("mouseup", handleMouseUp, true);

            // Remove all highlights
            document.querySelectorAll("[data-terminal-id]").forEach((el) => {
              (el as HTMLElement).style.outline = "";
            });

            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            const pane = el?.closest("[data-terminal-id]") as HTMLElement | null;
            const targetId = pane?.getAttribute("data-terminal-id");

            if (targetId && targetId !== terminalId && onSwapPane) {
              onSwapPane(terminalId, targetId);
            }
          };

          // Use capture phase so xterm.js stopPropagation() can't block us
          document.addEventListener("mousemove", handleMouseMove, true);
          document.addEventListener("mouseup", handleMouseUp, true);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: "100%",
          cursor: "grab",
          flexShrink: 0,
          opacity: 0.4,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.8"; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.4"; }}
        title="Drag to rearrange"
      >
        <svg width="6" height="10" viewBox="0 0 6 10" fill="var(--ezy-text-muted)">
          <circle cx="1.5" cy="1.5" r="1" />
          <circle cx="4.5" cy="1.5" r="1" />
          <circle cx="1.5" cy="5" r="1" />
          <circle cx="4.5" cy="5" r="1" />
          <circle cx="1.5" cy="8.5" r="1" />
          <circle cx="4.5" cy="8.5" r="1" />
        </svg>
      </div>
      {/* Left: type badge — clickable to switch CLI */}
      <div style={{ position: "relative" }}>
        <div
          className="flex items-center gap-1.5"
          style={{ cursor: "pointer", borderRadius: 4, padding: "2px 4px", margin: "-2px -4px" }}
          onClick={() => setShowTypePicker((v) => !v)}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
        >
          <TerminalIcon type={terminalType} />
          <span
            className="text-[11px] font-medium tracking-wide"
            style={{
              color: isActive ? "var(--ezy-text)" : "var(--ezy-text-muted)",
              letterSpacing: "0.04em",
            }}
          >
            {config.label}
            {serverName && (
              <span style={{ color: "var(--ezy-cyan)", marginLeft: 2 }}>
                @ {serverName}
              </span>
            )}
          </span>
          {isYolo && (
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
              }}
            >
              YOLO
            </span>
          )}
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1,2.5 4,5.5 7,2.5" />
          </svg>
        </div>
        {showTypePicker && (
          <CliPicker
            currentType={terminalType}
            onSelect={(type) => {
              if (type !== terminalType) onChangeType(type);
            }}
            onClose={() => setShowTypePicker(false)}
          />
        )}
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={onClose}
          title="Close Pane (Ctrl+Shift+W)"
          className="p-1 rounded transition-colors group"
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
  );
}

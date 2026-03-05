import { useState, useRef, useEffect } from "react";
import type { TerminalType } from "../types";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";
import { useAppStore } from "../store";

interface ToolSelectorProps {
  onSelect: (type: TerminalType, serverId?: string) => void;
  onClose: () => void;
  anchorEl?: HTMLElement | null;
}

function ToolIcon({ type, size = 18 }: { type: TerminalType; size?: number }) {
  switch (type) {
    case "claude":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <path
            d="M8 1L14.93 5.5V12.5L8 15L1.07 12.5V5.5L8 1Z"
            fill="#e6733a"
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

const TOOL_ORDER: TerminalType[] = ["claude", "codex", "gemini", "shell"];

interface MenuItem {
  type: TerminalType;
  serverId?: string;
  sectionHeader?: string;
}

export default function ToolSelector({
  onSelect,
  onClose,
}: ToolSelectorProps) {
  const servers = useAppStore((s) => s.servers);
  const [hoveredIndex, setHoveredIndex] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Build flat menu items list: Local tools, then per-server tools
  const menuItems: MenuItem[] = [];

  if (servers.length > 0) {
    // Add "Local" section header marker on first local item
    TOOL_ORDER.forEach((type, i) => {
      menuItems.push({
        type,
        sectionHeader: i === 0 ? "Local" : undefined,
      });
    });

    // Add per-server sections
    for (const server of servers) {
      TOOL_ORDER.forEach((type, i) => {
        menuItems.push({
          type,
          serverId: server.id,
          sectionHeader: i === 0 ? server.name : undefined,
        });
      });
    }
  } else {
    // No servers — flat list like before
    TOOL_ORDER.forEach((type) => {
      menuItems.push({ type });
    });
  }

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Keyboard nav
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHoveredIndex((i) => (i + 1) % menuItems.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHoveredIndex(
          (i) => (i - 1 + menuItems.length) % menuItems.length
        );
      } else if (e.key === "Enter") {
        const item = menuItems[hoveredIndex];
        if (item) onSelect(item.type, item.serverId);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [hoveredIndex, onClose, onSelect, menuItems]);

  return (
    <div
      ref={dropdownRef}
      className="dropdown-enter"
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        marginTop: 4,
        width: 260,
        backgroundColor: "var(--ezy-surface-raised)",
        border: "1px solid var(--ezy-border)",
        borderRadius: 8,
        overflow: "hidden",
        boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
        zIndex: 100,
        maxHeight: 400,
        overflowY: "auto",
      }}
    >
      <div
        style={{
          padding: "6px 10px",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--ezy-text-muted)",
          borderBottom: "1px solid var(--ezy-border)",
        }}
      >
        New Terminal
      </div>

      {menuItems.map((item, index) => {
        const config = TERMINAL_CONFIGS[item.type];
        const isShell = item.type === "shell";
        const isHovered = hoveredIndex === index;

        return (
          <div key={`${item.serverId ?? "local"}-${item.type}`}>
            {/* Section header for grouped mode */}
            {item.sectionHeader && (
              <div
                style={{
                  padding: "6px 10px 4px",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: item.serverId ? "var(--ezy-cyan)" : "var(--ezy-text-muted)",
                  borderTop: index > 0 ? "1px solid var(--ezy-border)" : undefined,
                  marginTop: index > 0 ? 2 : 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {item.serverId && (
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-cyan)" strokeWidth="1.5">
                    <rect x="2" y="3" width="12" height="10" rx="1.5" />
                    <circle cx="5" cy="8" r="1" fill="var(--ezy-cyan)" stroke="none" />
                    <line x1="8" y1="8" x2="12" y2="8" strokeLinecap="round" />
                  </svg>
                )}
                {item.sectionHeader}
              </div>
            )}
            {/* Separator before shell in flat mode (no servers) */}
            {isShell && servers.length === 0 && (
              <div
                style={{
                  height: 1,
                  backgroundColor: "var(--ezy-border)",
                  margin: "2px 10px",
                }}
              />
            )}
            <button
              className="w-full text-left"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                backgroundColor: isHovered
                  ? "rgba(57, 211, 83, 0.08)"
                  : "transparent",
                border: "none",
                cursor: "pointer",
                transition: "background-color 100ms ease",
                outline: "none",
              }}
              onMouseEnter={() => setHoveredIndex(index)}
              onClick={() => onSelect(item.type, item.serverId)}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 6,
                  backgroundColor: "var(--ezy-border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <ToolIcon type={item.type} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: isHovered ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
                  }}
                >
                  {config.label}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--ezy-text-muted)",
                    marginTop: 1,
                  }}
                >
                  {config.description}
                </div>
              </div>
              {isHovered && (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="var(--ezy-accent)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  style={{ marginLeft: "auto", flexShrink: 0 }}
                >
                  <polyline points="2,8 6,12 14,4" />
                </svg>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}

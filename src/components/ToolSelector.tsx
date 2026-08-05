import { useState, useRef, useEffect, useCallback } from "react";
import type { TerminalBackend, TerminalType } from "../types";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";
import { useAppStore } from "../store";
import { cliStatus, isAiCli, type CliStatus } from "../lib/cli-availability";
import { requestCliInstall } from "../lib/cli-install-modal";

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
  const terminalBackend = useAppStore((s) => s.terminalBackend);
  const [hoveredIndex, setHoveredIndex] = useState(0);
  // No hole-cut publisher: this selector only renders on a brand-new EMPTY
  // tab (needsInitialTerminal) — there is no native pane to occlude it.
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

  // Which of these CLIs are actually installed where the row would run them.
  //
  // Local backends answer from the startup cache, so this costs nothing. SSH
  // rows are read from what Test Connection already probed and NEVER probe
  // here: opening a menu must not fire an SSH round-trip per server, and a
  // server nobody has tested simply shows no tag.
  const [statuses, setStatuses] = useState<Record<string, CliStatus>>({});
  useEffect(() => {
    let alive = true;
    const localBackend: TerminalBackend = terminalBackend ?? "wsl";
    const record = (key: string, status: CliStatus) => {
      if (!alive || status === "unknown") return;
      setStatuses((prev) => (prev[key] === status ? prev : { ...prev, [key]: status }));
    };
    for (const type of TOOL_ORDER) {
      if (!isAiCli(type)) continue;
      void cliStatus(type, localBackend).then((s) => record(`local-${type}`, s));
      for (const server of servers) {
        if (!server.detectedCliShells) continue;
        void cliStatus(type, "ssh", server).then((s) => record(`${server.id}-${type}`, s));
      }
    }
    return () => {
      alive = false;
    };
  }, [servers, terminalBackend]);

  const statusOf = (type: TerminalType, serverId?: string): CliStatus | undefined =>
    isAiCli(type) ? statuses[`${serverId ?? "local"}-${type}`] : undefined;

  /** A row for a CLI that isn't there installs it first, then opens the pane —
   *  rather than opening a pane that can only report "command not found". */
  const choose = useCallback(
    (type: TerminalType, serverId: string | undefined, missing: boolean) => {
      if (!missing || !isAiCli(type)) {
        onSelect(type, serverId);
        return;
      }
      onClose();
      requestCliInstall({
        cli: type,
        backend: serverId ? "ssh" : (terminalBackend ?? "wsl"),
        serverId,
        onLaunch: () => onSelect(type, serverId),
        launchLabel: "Open pane",
      });
    },
    [onSelect, onClose, terminalBackend],
  );

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
        if (item) choose(item.type, item.serverId, statusOf(item.type, item.serverId) === "missing");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // No dep array on purpose: `menuItems` is rebuilt every render, so this
    // effect already re-subscribed every render before `statuses` existed.
    // Listing deps here would only pretend otherwise.
  });

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
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
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
          fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
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
        const missing = statusOf(item.type, item.serverId) === "missing";

        return (
          <div key={`${item.serverId ?? "local"}-${item.type}`}>
            {/* Section header for grouped mode */}
            {item.sectionHeader && (
              <div
                style={{
                  padding: "6px 10px 4px",
                  fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
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
              onClick={() => choose(item.type, item.serverId, missing)}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
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
                    fontSize: "calc(var(--ezy-font-scale, 1) * 13px)",
                    fontWeight: 500,
                    color: isHovered ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
                  }}
                >
                  {config.label}
                </div>
                <div
                  style={{
                    fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
                    color: "var(--ezy-text-muted)",
                    marginTop: 1,
                  }}
                >
                  {missing ? "Not installed — click to install" : config.description}
                </div>
              </div>
              {missing && (
                <div
                  style={{
                    marginLeft: "auto",
                    flexShrink: 0,
                    fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
                    fontWeight: 600,
                    letterSpacing: "0.04em",
                    padding: "2px 6px",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                    backgroundColor: "var(--ezy-surface)",
                    border: "1px solid var(--ezy-border-light)",
                    color: "var(--ezy-text-secondary)",
                  }}
                >
                  Install
                </div>
              )}
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

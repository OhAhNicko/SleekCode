import { useEffect, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../store";

interface MenuItem {
  label: string;
  shortcut: string;
  action: () => void;
  icon: React.ReactNode;
}

interface MenuSection {
  items: MenuItem[];
}

const MENU_WIDTH = 240;

// Inline SVG icons (14px)
const CopyIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/>
    <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/>
  </svg>
);

const PasteIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M5.75 1a.75.75 0 00-.75.75v.5c0 .138.112.25.25.25h5a.25.25 0 00.25-.25v-.5a.75.75 0 00-.75-.75h-4zM4 2.5v-.75A2.25 2.25 0 016.25-.5h3.5A2.25 2.25 0 0112 2v.5h.5A1.5 1.5 0 0114 4v10a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 14V4a1.5 1.5 0 011.5-1.5H4z"/>
  </svg>
);

const ClearIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
  </svg>
);

const SplitRightIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0014.5 2h-13zM1.5 3.5h5.75v9H1.5v-9zm7.25 9v-9h5.75v9H8.75z"/>
  </svg>
);

const SplitDownIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0014.5 2h-13zM1.5 3.5h13v3.75H1.5V3.5zm0 5.25h13v3.75H1.5V8.75z"/>
  </svg>
);

const ClosePaneIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/>
  </svg>
);

const NewTabIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z"/>
  </svg>
);

const PaletteIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm0 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM6.379 5.227L4.854 6.752a.75.75 0 000 1.06l1.525 1.526a.75.75 0 001.06-1.06L6.974 7.81h3.276a.75.75 0 000-1.5H6.974l.465-.465a.75.75 0 00-1.06-1.06v-.058z"/>
  </svg>
);

const SidebarIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0014.5 2h-13zM1.5 3.5h3.75v9H1.5v-9zm5.25 9v-9h7.75v9H6.75z"/>
  </svg>
);

const SettingsIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 0a1 1 0 01.994.884l.12 1.065a5.54 5.54 0 011.523.879l.987-.454a1 1 0 011.272.396l1 1.732a1 1 0 01-.278 1.28l-.867.611a5.6 5.6 0 010 1.214l.867.611a1 1 0 01.278 1.28l-1 1.732a1 1 0 01-1.272.396l-.987-.454a5.54 5.54 0 01-1.522.88l-.121 1.064A1 1 0 018 16H7a1 1 0 01-.994-.884l-.12-1.065a5.54 5.54 0 01-1.523-.879l-.987.454a1 1 0 01-1.272-.396l-1-1.732a1 1 0 01.278-1.28l.867-.611a5.6 5.6 0 010-1.214l-.867-.611a1 1 0 01-.278-1.28l1-1.732a1 1 0 011.272-.396l.987.454a5.54 5.54 0 011.522-.88l.121-1.064A1 1 0 017 0h1zm-.5 10a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"/>
  </svg>
);

const KeyboardIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0114.25 14H1.75A1.75 1.75 0 010 12.25v-8.5zm1.75-.25a.25.25 0 00-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 00.25-.25v-8.5a.25.25 0 00-.25-.25H1.75zM4 11a1 1 0 011-1h6a1 1 0 110 2H5a1 1 0 01-1-1zm-1-4a1 1 0 011-1h.01a1 1 0 010 2H4a1 1 0 01-1-1zm3 0a1 1 0 011-1h.01a1 1 0 010 2H7a1 1 0 01-1-1zm3 0a1 1 0 011-1h.01a1 1 0 010 2H10a1 1 0 01-1-1zm3 0a1 1 0 011-1h.01a1 1 0 010 2H13a1 1 0 01-1-1z"/>
  </svg>
);

export default function GlobalContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; isTerminal: boolean } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuHeight, setMenuHeight] = useState(0);

  const close = useCallback(() => setMenu(null), []);

  // Measure menu height after rendering for bottom-edge clamping
  useEffect(() => {
    if (menu && menuRef.current) {
      setMenuHeight(menuRef.current.offsetHeight);
    }
  }, [menu]);

  // Listen for contextmenu in bubble phase
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      // If another component already handled this, skip
      if (e.defaultPrevented) return;

      e.preventDefault();

      // Detect terminal context
      const target = e.target as HTMLElement;
      const isTerminal = !!target.closest?.("[data-terminal-id]");

      setMenu({ x: e.clientX, y: e.clientY, isTerminal });
    };

    window.addEventListener("contextmenu", handler);
    return () => window.removeEventListener("contextmenu", handler);
  }, []);

  // Escape to dismiss
  useEffect(() => {
    if (!menu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [menu, close]);

  if (!menu) return null;

  // Build sections
  const sections: MenuSection[] = [];

  // Clipboard section
  sections.push({
    items: [
      {
        label: "Copy",
        shortcut: "Ctrl+Shift+C",
        icon: CopyIcon,
        action: () => { document.execCommand("copy"); close(); },
      },
      {
        label: "Paste",
        shortcut: "Ctrl+Shift+V",
        icon: PasteIcon,
        action: () => {
          navigator.clipboard.readText().then((text) => {
            window.dispatchEvent(new CustomEvent("ezydev:paste-text", { detail: { text } }));
          }).catch(() => {});
          close();
        },
      },
    ],
  });

  // Terminal-specific section
  if (menu.isTerminal) {
    sections.push({
      items: [
        {
          label: "Clear Terminal",
          shortcut: "Ctrl+L",
          icon: ClearIcon,
          action: () => { window.dispatchEvent(new Event("ezydev:clear-terminal")); close(); },
        },
        {
          label: "Split Right",
          shortcut: "Ctrl+D",
          icon: SplitRightIcon,
          action: () => { window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type: "shell" } })); close(); },
        },
        {
          label: "Split Down",
          shortcut: "Ctrl+Shift+D",
          icon: SplitDownIcon,
          action: () => { window.dispatchEvent(new CustomEvent("ezydev:split-terminal", { detail: { type: "shell", direction: "vertical" } })); close(); },
        },
        {
          label: "Close Pane",
          shortcut: "Ctrl+W",
          icon: ClosePaneIcon,
          action: () => { window.dispatchEvent(new Event("ezydev:close-pane")); close(); },
        },
      ],
    });
  }

  // App actions section
  sections.push({
    items: [
      {
        label: "New Tab",
        shortcut: "Ctrl+Shift+T",
        icon: NewTabIcon,
        action: () => { window.dispatchEvent(new Event("ezydev:new-tab")); close(); },
      },
      {
        label: "Command Palette",
        shortcut: "Ctrl+K",
        icon: PaletteIcon,
        action: () => { window.dispatchEvent(new Event("ezydev:open-palette")); close(); },
      },
      {
        label: "Toggle Sidebar",
        shortcut: "Ctrl+B",
        icon: SidebarIcon,
        action: () => { useAppStore.getState().toggleSidebar(); close(); },
      },
      {
        label: "Settings",
        shortcut: "Ctrl+,",
        icon: SettingsIcon,
        action: () => { useAppStore.getState().toggleSettingsPanel(); close(); },
      },
    ],
  });

  // Help section
  sections.push({
    items: [
      {
        label: "Keyboard Shortcuts",
        shortcut: "Ctrl+/",
        icon: KeyboardIcon,
        action: () => { window.dispatchEvent(new Event("ezydev:open-shortcuts")); close(); },
      },
    ],
  });

  // Viewport clamping
  const clampedX = Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8);
  let clampedY = menu.y;
  // If we've measured height and it overflows bottom, flip above cursor
  if (menuHeight > 0 && menu.y + menuHeight > window.innerHeight - 8) {
    clampedY = Math.max(8, menu.y - menuHeight);
  }
  clampedY = Math.max(8, clampedY);

  return createPortal(
    <div
      style={{ position: "fixed", inset: 0, zIndex: 210 }}
      onClick={close}
      onContextMenu={(e) => { e.preventDefault(); close(); }}
    >
      <div
        ref={menuRef}
        className="dropdown-enter"
        style={{
          position: "absolute",
          top: clampedY,
          left: clampedX,
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 6,
          padding: "4px 0",
          minWidth: MENU_WIDTH,
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {sections.map((section, si) => (
          <div key={si}>
            {si > 0 && (
              <div style={{
                height: 1,
                backgroundColor: "var(--ezy-border-subtle)",
                margin: "4px 0",
              }} />
            )}
            {section.items.map((item) => (
              <div
                key={item.label}
                onClick={item.action}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 12px",
                  fontSize: 12,
                  color: "var(--ezy-text)",
                  cursor: "pointer",
                  transition: "background-color 80ms ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
              >
                <span style={{ display: "flex", alignItems: "center", color: "var(--ezy-text-muted)", flexShrink: 0 }}>
                  {item.icon}
                </span>
                <span style={{ flex: 1 }}>{item.label}</span>
                <span style={{ color: "var(--ezy-text-muted)", fontSize: 11, flexShrink: 0 }}>
                  {item.shortcut}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

// Shared model for the global right-click context menu.
//
// The MAIN webview owns the action closures (they dispatch window events / call
// the store) and the OVERLAY webview renders the menu — so both must agree on
// the item list. This module holds the display model (label / shortcut / icon /
// action id) and the icons; the closures live in GlobalContextMenu keyed by the
// same `actionId`. Icons are shared JSX so they render identically in either
// webview bundle.

import type { ReactNode } from "react";

export const CTX_MENU_WIDTH = 240;

export type CtxMenuItem = {
  actionId: string;
  label: string;
  shortcut: string;
  iconId: string;
};
export type CtxMenuSection = { items: CtxMenuItem[] };

// ---- icons (16x16 viewBox, currentColor) -----------------------------------

export const CTX_ICONS: Record<string, ReactNode> = {
  copy: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z" />
      <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z" />
    </svg>
  ),
  paste: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M5.75 1a.75.75 0 00-.75.75v.5c0 .138.112.25.25.25h5a.25.25 0 00.25-.25v-.5a.75.75 0 00-.75-.75h-4zM4 2.5v-.75A2.25 2.25 0 016.25-.5h3.5A2.25 2.25 0 0112 2v.5h.5A1.5 1.5 0 0114 4v10a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 14V4a1.5 1.5 0 011.5-1.5H4z" />
    </svg>
  ),
  clear: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
    </svg>
  ),
  "split-right": (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0014.5 2h-13zM1.5 3.5h5.75v9H1.5v-9zm7.25 9v-9h5.75v9H8.75z" />
    </svg>
  ),
  "split-down": (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0014.5 2h-13zM1.5 3.5h13v3.75H1.5V3.5zm0 5.25h13v3.75H1.5V8.75z" />
    </svg>
  ),
  "close-pane": (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
    </svg>
  ),
  "new-tab": (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
    </svg>
  ),
  palette: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm0 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM6.379 5.227L4.854 6.752a.75.75 0 000 1.06l1.525 1.526a.75.75 0 001.06-1.06L6.974 7.81h3.276a.75.75 0 000-1.5H6.974l.465-.465a.75.75 0 00-1.06-1.06v-.058z" />
    </svg>
  ),
  sidebar: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0014.5 2h-13zM1.5 3.5h3.75v9H1.5v-9zm5.25 9v-9h7.75v9H6.75z" />
    </svg>
  ),
  settings: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0a1 1 0 01.994.884l.12 1.065a5.54 5.54 0 011.523.879l.987-.454a1 1 0 011.272.396l1 1.732a1 1 0 01-.278 1.28l-.867.611a5.6 5.6 0 010 1.214l.867.611a1 1 0 01.278 1.28l-1 1.732a1 1 0 01-1.272.396l-.987-.454a5.54 5.54 0 01-1.522.88l-.121 1.064A1 1 0 018 16H7a1 1 0 01-.994-.884l-.12-1.065a5.54 5.54 0 01-1.523-.879l-.987.454a1 1 0 01-1.272-.396l-1-1.732a1 1 0 01.278-1.28l.867-.611a5.6 5.6 0 010-1.214l-.867-.611a1 1 0 01-.278-1.28l1-1.732a1 1 0 011.272-.396l.987.454a5.54 5.54 0 011.522-.88l.121-1.064A1 1 0 017 0h1zm-.5 10a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
    </svg>
  ),
  search: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M10.68 11.74a6 6 0 01-7.922-8.982 6 6 0 018.982 7.922l3.04 3.04a.749.749 0 01-.326 1.275.749.749 0 01-.734-.215l-3.04-3.04zM11.5 7a4.499 4.499 0 10-8.997 0A4.499 4.499 0 0011.5 7z" />
    </svg>
  ),
  keyboard: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0114.25 14H1.75A1.75 1.75 0 010 12.25v-8.5zm1.75-.25a.25.25 0 00-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 00.25-.25v-8.5a.25.25 0 00-.25-.25H1.75zM4 11a1 1 0 011-1h6a1 1 0 110 2H5a1 1 0 01-1-1zm-1-4a1 1 0 011-1h.01a1 1 0 010 2H4a1 1 0 01-1-1zm3 0a1 1 0 011-1h.01a1 1 0 010 2H7a1 1 0 01-1-1zm3 0a1 1 0 011-1h.01a1 1 0 010 2H10a1 1 0 01-1-1zm3 0a1 1 0 011-1h.01a1 1 0 010 2H13a1 1 0 01-1-1z" />
    </svg>
  ),
  devtools: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M5.28 4.22a.75.75 0 010 1.06L2.56 8l2.72 2.72a.75.75 0 11-1.06 1.06L.97 8.53a.75.75 0 010-1.06l3.25-3.25a.75.75 0 011.06 0zm5.44 0a.75.75 0 011.06 0l3.25 3.25a.75.75 0 010 1.06l-3.25 3.25a.75.75 0 11-1.06-1.06L13.44 8l-2.72-2.72a.75.75 0 010-1.06z" />
    </svg>
  ),
};

// ---- model builder ----------------------------------------------------------

/** The display model (no closures). Must stay in sync with `actionsFor` in
 *  GlobalContextMenu.tsx (matched by `actionId`). */
export function buildContextMenuSections(isTerminal: boolean): CtxMenuSection[] {
  const sections: CtxMenuSection[] = [];

  sections.push({
    items: [
      { actionId: "copy", label: "Copy", shortcut: "Ctrl+Shift+C", iconId: "copy" },
      { actionId: "paste", label: "Paste", shortcut: "Ctrl+Shift+V", iconId: "paste" },
    ],
  });

  if (isTerminal) {
    sections.push({
      items: [
        { actionId: "clear", label: "Clear Terminal", shortcut: "Ctrl+L", iconId: "clear" },
        { actionId: "split-right", label: "Split Right", shortcut: "Ctrl+D", iconId: "split-right" },
        { actionId: "split-down", label: "Split Down", shortcut: "Ctrl+Shift+D", iconId: "split-down" },
        { actionId: "close-pane", label: "Close Pane", shortcut: "Ctrl+W", iconId: "close-pane" },
      ],
    });
  }

  sections.push({
    items: [
      { actionId: "new-tab", label: "New Tab", shortcut: "Ctrl+Shift+T", iconId: "new-tab" },
      { actionId: "palette", label: "Command Palette", shortcut: "Ctrl+K", iconId: "palette" },
      { actionId: "toggle-sidebar", label: "Toggle Sidebar", shortcut: "Ctrl+B", iconId: "sidebar" },
      { actionId: "settings", label: "Settings", shortcut: "Ctrl+,", iconId: "settings" },
    ],
  });

  sections.push({
    items: [
      { actionId: "prompt-search", label: "Search Prompt History", shortcut: "Ctrl+R", iconId: "search" },
      { actionId: "shortcuts", label: "Keyboard Shortcuts", shortcut: "Ctrl+/", iconId: "keyboard" },
      { actionId: "devtools", label: "Open DevTools", shortcut: "F12", iconId: "devtools" },
    ],
  });

  return sections;
}

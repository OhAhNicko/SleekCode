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

// ---- CLI brand icons (shared with the overlay's anchored menus) -------------

CTX_ICONS["cli-claude"] = (
  <svg width="14" height="14" viewBox="0 0 24 24">
    <path
      d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
      fill="#D97757"
    />
  </svg>
);
CTX_ICONS["cli-codex"] = (
  <svg width="14" height="14" viewBox="0 0 24 24">
    <path
      d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"
      fill="#10a37f"
    />
  </svg>
);
CTX_ICONS["cli-gemini"] = (
  <svg width="14" height="14" viewBox="0 0 24 24">
    <path
      d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"
      fill="#8E75B2"
    />
  </svg>
);
CTX_ICONS["cli-shell"] = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="var(--ezy-text-muted, rgba(230,237,243,0.5))" strokeWidth="1" />
    <path d="M4.5 6L6.5 8L4.5 10" stroke="var(--ezy-accent, #10a37f)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="8" y1="10" x2="11" y2="10" stroke="var(--ezy-text-muted, rgba(230,237,243,0.5))" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

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

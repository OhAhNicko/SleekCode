// Selector between xterm.js and native (wgpu) renderers.
//
// Precedence, highest first:
//   1. `paneRendererOverride[terminalId]` — runtime-only escape hatch.
//   2. `renderer` prop — the pane's own persisted choice, stored on its layout
//      leaf and stamped when the pane is created from the "Add pane" dropdown.
//   3. `useNativeTerminalRenderer` — the global Settings toggle.
//
// Consumers import this file; they don't need to know which renderer is active.

import { useAppStore } from "../store";
import TerminalPaneNative from "./TerminalPaneNative";
import TerminalPaneXterm from "./TerminalPaneXterm";
import type { CommandBlock } from "../lib/command-block-parser";
import type { TerminalType, TerminalBackend, TerminalRenderer } from "../types";

// Re-export the shared focus-suppression set so existing call sites in
// Workspace.tsx etc. that import `suppressFocusTerminals` from "./TerminalPane"
// keep working unchanged.
export { suppressFocusTerminals } from "./TerminalPaneXterm";

interface TerminalPaneProps {
  terminalId: string;
  terminalType: TerminalType;
  workingDir: string;
  isActive: boolean;
  /**
   * Is this pane's TAB the one on screen?
   *
   * `isActive` is per-Workspace state, and App.tsx mounts a Workspace for EVERY
   * open project tab (inactive ones are `display:none`, not unmounted). So with
   * N tabs open, N panes have `isActive === true` simultaneously — fine for
   * tab-local things like the active-pane highlight, catastrophic for anything
   * that claims a PROCESS-GLOBAL resource. See the Win32 keyboard-focus guard in
   * TerminalPaneNative.
   */
  isTabActive: boolean;
  /** Overrides the per-project pane tint (Jira: each ticket's pane is tinted
   *  with its ticket color regardless of the global project-tint toggle). */
  paneTintOverride?: string | null;
  paneCount?: number;
  onClose: () => void;
  onChangeType: (type: TerminalType) => void;
  onFocus: () => void;
  onSwapPane?: (fromTerminalId: string, toTerminalId: string) => void;
  onExplainError?: (block: CommandBlock) => void;
  onPtyReady?: () => void;
  onPtyExit?: (exitCode: number) => void;
  hideChrome?: boolean;
  serverId?: string;
  sessionResumeId?: string;
  onSessionResumeId?: (id: string) => void;
  onSwitchSession?: (newSessionId: string | undefined) => void;
  backend?: TerminalBackend;
  /** This pane's persisted renderer choice (from its layout leaf). */
  renderer?: TerminalRenderer;
}

export default function TerminalPane({
  renderer,
  isTabActive,
  ...props
}: TerminalPaneProps) {
  const useNative = useAppStore((s) => s.useNativeTerminalRenderer);
  const override = useAppStore((s) => s.paneRendererOverride[props.terminalId]);
  const resolved = override ?? renderer ?? (useNative ? "native" : "xterm");
  // `renderer` is deliberately NOT forwarded — neither implementation declares it.
  // `isTabActive` goes only to the native pane: it gates a Win32 keyboard-focus
  // claim, which the xterm pane has no equivalent of (its `.focus()` is DOM
  // focus, which cannot be contended across hidden tabs the same way).
  return resolved === "native" ? (
    <TerminalPaneNative {...props} isTabActive={isTabActive} />
  ) : (
    <TerminalPaneXterm {...props} />
  );
}

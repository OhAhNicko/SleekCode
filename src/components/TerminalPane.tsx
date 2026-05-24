// Selector between xterm.js and native (wgpu) renderers.
//
// Reads `useNativeTerminalRenderer` (global) + `paneRendererOverride[id]`
// (per-pane) from nativeRendererSlice and dispatches to the matching pane
// implementation. Consumers import this file; they don't need to know which
// renderer is active.

import { useAppStore } from "../store";
import TerminalPaneNative from "./TerminalPaneNative";
import TerminalPaneXterm from "./TerminalPaneXterm";
import type { CommandBlock } from "../lib/command-block-parser";
import type { TerminalType, TerminalBackend } from "../types";

// Re-export the shared focus-suppression set so existing call sites in
// Workspace.tsx etc. that import `suppressFocusTerminals` from "./TerminalPane"
// keep working unchanged.
export { suppressFocusTerminals } from "./TerminalPaneXterm";

interface TerminalPaneProps {
  terminalId: string;
  terminalType: TerminalType;
  workingDir: string;
  isActive: boolean;
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
}

export default function TerminalPane(props: TerminalPaneProps) {
  const useNative = useAppStore((s) => s.useNativeTerminalRenderer);
  const override = useAppStore((s) => s.paneRendererOverride[props.terminalId]);
  const resolved = override ?? (useNative ? "native" : "xterm");
  return resolved === "native" ? (
    <TerminalPaneNative {...props} />
  ) : (
    <TerminalPaneXterm {...props} />
  );
}

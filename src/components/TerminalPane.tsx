import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { getTheme } from "../lib/themes";
import { usePty } from "../hooks/usePty";
import { useAppStore } from "../store";
import { registerPtyWrite, unregisterPtyWrite } from "../store/terminalSlice";
import type { TerminalType } from "../types";
import { CommandBlockParser, type CommandBlock } from "../lib/command-block-parser";
import { shouldInjectShellIntegration } from "../lib/shell-integration";
import TerminalHeader from "./TerminalHeader";
import CommandBlockOverlay from "./CommandBlockOverlay";

interface TerminalPaneProps {
  terminalId: string;
  terminalType: TerminalType;
  workingDir: string;
  isActive: boolean;
  onClose: () => void;
  onSplit: (direction: "horizontal" | "vertical", type: TerminalType) => void;
  onChangeType: (type: TerminalType) => void;
  onFocus: () => void;
  onSwapPane?: (fromTerminalId: string, toTerminalId: string) => void;
  onMarkDevServer?: () => void;
  onOpenEditor?: () => void;
  onOpenBrowser?: () => void;
  onOpenTasks?: () => void;
  onExplainError?: (block: CommandBlock) => void;
  onOpenSnippets?: () => void;
  serverId?: string;
}

export default function TerminalPane({
  terminalId,
  terminalType,
  workingDir,
  isActive,
  onClose,
  onSplit,
  onChangeType,
  onFocus,
  onSwapPane,
  onMarkDevServer,
  onOpenEditor,
  onOpenBrowser,
  onOpenTasks,
  onExplainError,
  onOpenSnippets,
  serverId,
}: TerminalPaneProps) {
  const serverName = useAppStore((s) => {
    if (!serverId) return undefined;
    return s.servers.find((srv) => srv.id === serverId)?.name;
  });
  const themeId = useAppStore((s) => s.themeId);
  const theme = getTheme(themeId);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [exited, setExited] = useState(false);
  const [commandBlocks, setCommandBlocks] = useState<CommandBlock[]>([]);
  const blockParserRef = useRef<CommandBlockParser | null>(null);
  const recordedBlocksRef = useRef<Set<string>>(new Set());
  const initialDims = useRef({ cols: 80, rows: 24 });
  const useShellIntegration = shouldInjectShellIntegration(terminalType);

  const handlePtyData = useCallback((data: Uint8Array) => {
    terminalRef.current?.write(new Uint8Array(data));
  }, []);

  const handlePtyExit = useCallback((_exitCode: number) => {
    setExited(true);
    terminalRef.current?.write("\r\n\x1b[38;2;139;148;158m[Process exited]\x1b[0m\r\n");
  }, []);

  const { write, resize, kill } = usePty({
    terminalType,
    workingDir,
    cols: initialDims.current.cols,
    rows: initialDims.current.rows,
    onData: handlePtyData,
    onExit: handlePtyExit,
    serverId,
    injectShellIntegration: useShellIntegration,
  });

  // Initialize xterm.js
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: theme.terminal,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      fontFamily: "'Geist Mono', 'Cascadia Code', 'Fira Code', monospace",
      fontSize: 13,
      lineHeight: 1.35,
      letterSpacing: 0,
      allowTransparency: true,
      scrollback: 10000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    term.open(containerRef.current);

    // Try WebGL, fall back to canvas
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // Canvas renderer is the default fallback
    }

    fitAddon.fit();
    initialDims.current = { cols: term.cols, rows: term.rows };

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Register command block parser for shell terminals
    if (useShellIntegration) {
      const parser = new CommandBlockParser(term, setCommandBlocks);
      parser.register();
      blockParserRef.current = parser;
    }

    // Wire terminal input to PTY
    const dataDisposable = term.onData((data) => {
      if (!exited) write(data);
    });

    const resizeDisposable = term.onResize((e) => {
      resize(e.cols, e.rows);
    });

    // ResizeObserver for auto-fit
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
        } catch {
          // Container may be detached
        }
      });
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      blockParserRef.current?.dispose();
      blockParserRef.current = null;
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  // Register PTY write callback for external access (AI explain, snippets)
  useEffect(() => {
    registerPtyWrite(terminalId, write);
    return () => unregisterPtyWrite(terminalId);
  }, [terminalId, write]);

  // Feed completed command blocks into history store
  useEffect(() => {
    const addHistoryEntry = useAppStore.getState().addHistoryEntry;
    const tabs = useAppStore.getState().tabs;
    const tab = tabs.find((t) =>
      t.layout.type === "terminal" ? t.layout.terminalId === terminalId : false
    );
    const tabName = tab?.name ?? "Shell";

    for (const block of commandBlocks) {
      if (block.exitCode !== null && !recordedBlocksRef.current.has(block.id)) {
        recordedBlocksRef.current.add(block.id);
        addHistoryEntry({
          command: block.command,
          exitCode: block.exitCode,
          timestamp: block.timestamp,
          endTimestamp: block.endTimestamp,
          workingDir,
          terminalId,
          tabName,
        });
      }
    }
  }, [commandBlocks, terminalId, workingDir]);

  // Clear terminal when CLI type changes (PTY restarts via usePty)
  const prevTypeRef = useRef(terminalType);
  useEffect(() => {
    if (prevTypeRef.current !== terminalType) {
      prevTypeRef.current = terminalType;
      if (terminalRef.current) {
        terminalRef.current.clear();
        terminalRef.current.reset();
      }
      setExited(false);
      setCommandBlocks([]);
    }
  }, [terminalType]);

  // Focus management
  useEffect(() => {
    if (isActive && terminalRef.current) {
      terminalRef.current.focus();
    }
  }, [isActive]);

  // Theme hot-swap
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = theme.terminal;
    }
  }, [theme]);

  const handleToggleCollapse = useCallback((blockId: string) => {
    blockParserRef.current?.toggleCollapse(blockId);
  }, []);

  const handleClose = useCallback(() => {
    kill();
    onClose();
  }, [kill, onClose]);

  return (
    <div
      className={`terminal-pane flex flex-col h-full w-full ${isActive ? "pane-active" : ""}`}
      style={{ backgroundColor: "var(--ezy-bg)" }}
      data-terminal-id={terminalId}
      onClick={onFocus}
    >
      <TerminalHeader
        terminalId={terminalId}
        terminalType={terminalType}
        isActive={isActive}
        onSplit={onSplit}
        onChangeType={onChangeType}
        onClose={handleClose}
        onSwapPane={onSwapPane}
        onMarkDevServer={onMarkDevServer}
        onOpenEditor={onOpenEditor}
        onOpenBrowser={onOpenBrowser}
        onOpenTasks={onOpenTasks}
        onOpenSnippets={onOpenSnippets}
        serverName={serverName}
      />
      <div className="flex-1 min-h-0 relative" style={{ backgroundColor: "var(--ezy-bg)" }}>
        <div
          ref={containerRef}
          className="h-full w-full"
        />
        {useShellIntegration && (
          <CommandBlockOverlay
            terminal={terminalRef.current}
            blocks={commandBlocks}
            onToggleCollapse={handleToggleCollapse}
            onExplainError={onExplainError}
          />
        )}
      </div>
    </div>
  );
}

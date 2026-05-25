/**
 * Native command-block parser hook.
 *
 * Mirrors the xterm-backed CommandBlockParser (src/lib/command-block-parser.ts)
 * but sources its events from the Rust renderer's `osc133` channel instead of
 * tapping xterm's parser. We deliberately do NOT fork the entire parser file —
 * the xterm pane keeps using CommandBlockParser; the native pane uses this
 * hook. The shared `CommandBlock` shape (re-exported below for convenience)
 * keeps downstream UI consumers identical.
 *
 * Mapping:
 *   OSC 133;A → prompt-start  (open a pending block)
 *   OSC 133;B → command-input-start (no-op; we wait for C)
 *   OSC 133;C → command-output-start (records commandStartLine; running)
 *   OSC 133;D → command-end (resolves exitCode, finalizes block)
 *
 * Buffer text (command + output) is fetched on-demand via
 * `nativeTermGetBufferLines` so we don't block the OSC handler.
 */

import { useEffect, useRef, useState } from "react";
import {
  subscribeOsc133,
  nativeTermGetBufferLines,
  type NativeTermId,
  type Osc133Event,
} from "../lib/native-term-bridge";
import type { CommandBlock } from "../lib/command-block-parser";

export type { CommandBlock };

interface PendingBlock {
  promptLine: number;
  commandStartLine: number | null;
  startedAt: number;
}

export interface NativeCommandBlocksState {
  commandBlocks: CommandBlock[];
  /** Lines where OSC 133;A fired (for prompt-history features). */
  promptLines: number[];
}

export function useNativeCommandBlocks(
  termId: NativeTermId | null,
): NativeCommandBlocksState {
  const [commandBlocks, setCommandBlocks] = useState<CommandBlock[]>([]);
  const [promptLines, setPromptLines] = useState<number[]>([]);

  // Refs keep the state machine alive across renders without re-subscribing.
  const pendingRef = useRef<PendingBlock | null>(null);
  const blockCounterRef = useRef(0);
  const blocksRef = useRef<CommandBlock[]>([]);

  useEffect(() => {
    if (termId == null) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    (async () => {
      const u = await subscribeOsc133(termId, (e: Osc133Event) => {
        if (cancelled) return;
        switch (e.kind) {
          case "A": {
            // Prompt start — open a pending block at this line.
            pendingRef.current = {
              promptLine: e.absLine,
              commandStartLine: null,
              startedAt: Date.now(),
            };
            setPromptLines((prev) =>
              prev.length > 0 && prev[prev.length - 1] === e.absLine
                ? prev
                : [...prev, e.absLine],
            );
            break;
          }
          case "B": {
            // command-input-start — nothing to record; the next C nails
            // down the executing region.
            break;
          }
          case "C": {
            if (pendingRef.current) {
              pendingRef.current.commandStartLine = e.absLine;
            } else {
              // Defensive: synthesize a pending block if we missed A.
              pendingRef.current = {
                promptLine: e.absLine,
                commandStartLine: e.absLine,
                startedAt: Date.now(),
              };
            }
            break;
          }
          case "D": {
            const pending = pendingRef.current;
            pendingRef.current = null;
            if (!pending) break;
            const commandStartLine =
              pending.commandStartLine ?? pending.promptLine;
            const endLine = e.absLine;
            const id = `nblock-${++blockCounterRef.current}`;
            const block: CommandBlock = {
              id,
              command: "",
              promptLine: pending.promptLine,
              commandStartLine,
              commandEndLine: endLine,
              exitCode: e.exitCode,
              isCollapsed: false,
              timestamp: pending.startedAt,
              endTimestamp: Date.now(),
              outputText: null,
            };
            blocksRef.current = [...blocksRef.current, block];
            setCommandBlocks(blocksRef.current);

            // Fire-and-forget buffer fetch to backfill command + output.
            (async () => {
              try {
                const commandLines = await nativeTermGetBufferLines(
                  termId,
                  pending.promptLine,
                  commandStartLine + 1,
                );
                const rawCommand = commandLines.join("\n");
                const match = rawCommand.match(/[$>#]\s*(.+?)$/);
                const command = match ? match[1].trim() : rawCommand.trim();

                const outputLines = await nativeTermGetBufferLines(
                  termId,
                  commandStartLine + 1,
                  endLine,
                );
                const outputText =
                  outputLines.join("\n").trimEnd() || null;

                blocksRef.current = blocksRef.current.map((b) =>
                  b.id === id ? { ...b, command, outputText } : b,
                );
                if (!cancelled) setCommandBlocks(blocksRef.current);
              } catch {
                // Buffer reads can reject if the renderer was destroyed
                // mid-flight; safe to ignore — block keeps stub command.
              }
            })();
            break;
          }
        }
      });
      if (cancelled) {
        u();
        return;
      }
      unlisten = u;
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      // Reset between term ids so a remount doesn't show stale blocks.
      pendingRef.current = null;
      blocksRef.current = [];
      blockCounterRef.current = 0;
      setCommandBlocks([]);
      setPromptLines([]);
    };
  }, [termId]);

  return { commandBlocks, promptLines };
}

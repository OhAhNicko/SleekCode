import { useEffect, useState, useCallback, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { CommandBlock } from "../lib/command-block-parser";

interface CommandBlockOverlayProps {
  terminal: Terminal | null;
  blocks: CommandBlock[];
  onToggleCollapse: (blockId: string) => void;
  onExplainError?: (block: CommandBlock) => void;
}

interface VisibleBlock {
  block: CommandBlock;
  top: number;
  height: number;
}

function formatDuration(start: number, end: number | null): string | null {
  if (!end) return null;
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export default function CommandBlockOverlay({
  terminal,
  blocks,
  onToggleCollapse,
  onExplainError,
}: CommandBlockOverlayProps) {
  const [visibleBlocks, setVisibleBlocks] = useState<VisibleBlock[]>([]);
  const rafRef = useRef(0);

  const computeVisible = useCallback(() => {
    if (!terminal) return;
    const buf = terminal.buffer.active;
    const baseY = buf.baseY;
    const viewportRows = terminal.rows;

    // Compute cell height from terminal element
    const el = terminal.element;
    if (!el) return;
    const viewportEl = el.querySelector(".xterm-screen") as HTMLElement | null;
    if (!viewportEl) return;
    const viewportHeight = viewportEl.clientHeight;
    const cellHeight = viewportHeight / viewportRows;

    const visible: VisibleBlock[] = [];

    for (const block of blocks) {
      // The prompt line's position in viewport coordinates
      const viewportLine = block.promptLine - baseY;

      // Skip if completely outside viewport
      if (viewportLine < -1 || viewportLine > viewportRows) continue;

      const blockLines = block.commandEndLine - block.promptLine + 1;

      visible.push({
        block,
        top: viewportLine * cellHeight,
        height: blockLines * cellHeight,
      });
    }

    setVisibleBlocks(visible);
  }, [terminal, blocks]);

  // Recompute on blocks change
  useEffect(() => {
    computeVisible();
  }, [computeVisible]);

  // Recompute on scroll
  useEffect(() => {
    if (!terminal) return;

    const update = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(computeVisible);
    };

    const disposable = terminal.onScroll(update);
    const renderDisposable = terminal.onRender(update);

    return () => {
      cancelAnimationFrame(rafRef.current);
      disposable.dispose();
      renderDisposable.dispose();
    };
  }, [terminal, computeVisible]);

  if (visibleBlocks.length === 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 5,
      }}
    >
      {visibleBlocks.map(({ block, top, height }) => {
        const duration = formatDuration(block.timestamp, block.endTimestamp);
        const isError = block.exitCode !== null && block.exitCode !== 0;
        const gutterColor = isError ? "var(--ezy-red)" : "var(--ezy-accent)";

        return (
          <div
            key={block.id}
            style={{
              position: "absolute",
              top,
              left: 0,
              right: 0,
              height,
              pointerEvents: "none",
            }}
          >
            {/* Left gutter — 2px vertical line colored by exit code */}
            {block.exitCode !== null && (
              <div
                style={{
                  position: "absolute",
                  left: 1,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  backgroundColor: gutterColor,
                  borderRadius: 1,
                  opacity: 0.7,
                }}
              />
            )}

            {/* Top-right action bar */}
            <div
              style={{
                position: "absolute",
                top: 0,
                right: 8,
                display: "flex",
                alignItems: "center",
                gap: 4,
                pointerEvents: "auto",
                height: 18,
              }}
            >
              {/* Command text */}
              {block.command && (
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--ezy-text-muted)",
                    backgroundColor: "var(--ezy-surface)",
                    padding: "1px 6px",
                    borderRadius: 3,
                    maxWidth: 200,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    border: "1px solid var(--ezy-border)",
                    opacity: 0.85,
                  }}
                >
                  {block.command}
                </span>
              )}

              {/* Duration label */}
              {duration && (
                <span
                  style={{
                    fontSize: 9,
                    color: "var(--ezy-text-muted)",
                    opacity: 0.7,
                  }}
                >
                  {duration}
                </span>
              )}

              {/* Exit code badge */}
              {block.exitCode !== null && (
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 600,
                    padding: "1px 5px",
                    borderRadius: 3,
                    backgroundColor:
                      block.exitCode === 0 ? "var(--ezy-accent-dim)" : "var(--ezy-red)",
                    color: "#fff",
                  }}
                >
                  {block.exitCode === 0 ? "0" : block.exitCode}
                </span>
              )}

              {/* Copy button */}
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="var(--ezy-text-muted)"
                strokeWidth="1.3"
                strokeLinecap="round"
                style={{ cursor: "pointer", opacity: 0.7 }}
                onClick={() => {
                  const text = block.outputText
                    ? `$ ${block.command}\n${block.outputText}`
                    : `$ ${block.command}`;
                  navigator.clipboard.writeText(text);
                }}
              >
                <rect x="5" y="5" width="9" height="9" rx="1" />
                <path d="M5 11H3.5A1.5 1.5 0 0 1 2 9.5v-7A1.5 1.5 0 0 1 3.5 1h7A1.5 1.5 0 0 1 12 2.5V5" />
              </svg>

              {/* Explain Error button — only on failed blocks */}
              {isError && (
                <span
                  title={onExplainError ? "Explain Error with AI" : "Explain Error (coming soon)"}
                  style={{ display: "inline-flex" }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="var(--ezy-red)"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    style={{
                      cursor: onExplainError ? "pointer" : "default",
                      opacity: onExplainError ? 0.85 : 0.35,
                    }}
                    onClick={() => onExplainError?.(block)}
                  >
                    <circle cx="8" cy="8" r="6.5" />
                    <line x1="8" y1="5" x2="8" y2="9" />
                    <circle cx="8" cy="11.5" r="0.5" fill="var(--ezy-red)" stroke="none" />
                  </svg>
                </span>
              )}

              {/* Collapse chevron */}
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="var(--ezy-text-muted)"
                strokeWidth="1.5"
                strokeLinecap="round"
                style={{
                  cursor: "pointer",
                  opacity: 0.7,
                  transform: block.isCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
                  transition: "transform 150ms ease",
                }}
                onClick={() => {
                  onToggleCollapse(block.id);
                  // If collapsing, scroll terminal to next block
                  if (!block.isCollapsed && terminal) {
                    const nextLine = block.commandEndLine + 1;
                    const buf = terminal.buffer.active;
                    const targetBase = Math.max(0, nextLine - Math.floor(terminal.rows / 2));
                    if (targetBase !== buf.baseY) {
                      terminal.scrollToLine(targetBase);
                    }
                  }
                }}
              >
                <polyline points="4,6 8,10 12,6" />
              </svg>
            </div>
          </div>
        );
      })}
    </div>
  );
}

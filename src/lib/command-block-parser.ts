/**
 * OSC 133 command block parser for xterm.js.
 *
 * Registers handlers on the xterm parser to intercept OSC 133 sequences
 * and build a list of command blocks with line ranges and exit codes.
 */

import type { Terminal, IDisposable } from "@xterm/xterm";

export interface CommandBlock {
  id: string;
  command: string;
  promptLine: number;
  commandStartLine: number;
  commandEndLine: number;
  exitCode: number | null;
  isCollapsed: boolean;
  timestamp: number;
  endTimestamp: number | null;
  outputText: string | null;
}

type BlockState = "idle" | "prompt" | "input" | "running";

export class CommandBlockParser {
  private state: BlockState = "idle";
  private blocks: CommandBlock[] = [];
  private currentPromptLine = 0;
  private currentCommandStartLine = 0;
  private blockCounter = 0;
  private blocksSinceTrim = 0;
  private disposables: IDisposable[] = [];
  private onChange: (blocks: CommandBlock[]) => void;
  private terminal: Terminal;

  constructor(terminal: Terminal, onChange: (blocks: CommandBlock[]) => void) {
    this.terminal = terminal;
    this.onChange = onChange;
  }

  /** Get the current absolute line (baseY + cursorY). */
  private get absoluteLine(): number {
    const buf = this.terminal.buffer.active;
    return buf.baseY + buf.cursorY;
  }

  /** Register OSC 133 handlers on the terminal parser. */
  register(): void {
    const handler = this.terminal.parser.registerOscHandler(133, (data) => {
      this.handleOsc(data);
      return false; // don't prevent default handling
    });
    this.disposables.push(handler);
  }

  private handleOsc(data: string): void {
    const code = data.charAt(0);

    switch (code) {
      case "A": // Prompt start
        this.state = "prompt";
        this.currentPromptLine = this.absoluteLine;
        break;

      case "B": // Prompt end → input start
        this.state = "input";
        break;

      case "C": // Command execution start
        this.state = "running";
        this.currentCommandStartLine = this.absoluteLine;
        break;

      case "D": { // Command done
        if (this.state === "running" || this.state === "input") {
          const exitStr = data.length > 2 ? data.substring(2) : "0";
          const exitCode = parseInt(exitStr, 10);
          const endLine = this.absoluteLine;

          // Try to extract command text from the prompt line
          const command = this.extractCommand(
            this.currentPromptLine,
            this.currentCommandStartLine
          );

          // Only create a block if we have a valid command range
          if (this.currentCommandStartLine > 0) {
            const endTimestamp = Date.now();
            const outputText = this.extractOutput(
              this.currentCommandStartLine + 1,
              endLine
            );

            const block: CommandBlock = {
              id: `block-${++this.blockCounter}`,
              command,
              promptLine: this.currentPromptLine,
              commandStartLine: this.currentCommandStartLine,
              commandEndLine: endLine,
              exitCode: isNaN(exitCode) ? 0 : exitCode,
              isCollapsed: false,
              timestamp: Date.now(),
              endTimestamp,
              outputText,
            };

            this.blocks.push(block);
            this.blocksSinceTrim++;
            if (this.blocksSinceTrim >= 10) {
              this.trimBlocks();
              this.blocksSinceTrim = 0;
            }
            this.onChange(this.blocks);
          }
        }
        this.state = "idle";
        break;
      }
    }
  }

  /** Try to read the command text from the buffer between prompt and command start. */
  private extractCommand(promptLine: number, commandStartLine: number): string {
    const buf = this.terminal.buffer.active;
    // The command text is typically on the same line as the prompt
    // Read the prompt line(s) and try to extract just the command
    const endLine = Math.min(commandStartLine, promptLine + 3); // max 3 lines
    let text = "";
    for (let i = promptLine; i <= endLine; i++) {
      const line = buf.getLine(i);
      if (line) {
        text += line.translateToString(true);
      }
    }
    // Strip common prompt prefixes — grab text after last $ or > or #
    const match = text.match(/[$>#]\s*(.+?)$/);
    return match ? match[1].trim() : text.trim();
  }

  /** Extract output text from the buffer between two line numbers. Capped at 500 lines. */
  private extractOutput(startLine: number, endLine: number): string | null {
    const buf = this.terminal.buffer.active;
    const maxLines = 500;
    const actualEnd = Math.min(endLine, startLine + maxLines);
    const lines: string[] = [];
    for (let i = startLine; i < actualEnd; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    const text = lines.join("\n").trimEnd();
    return text.length > 0 ? text : null;
  }

  /** Evict blocks that have scrolled out of the terminal scrollback buffer. */
  private trimBlocks(): void {
    const buf = this.terminal.buffer.active;
    const scrollback = this.terminal.options.scrollback ?? 1000;
    const minLine = buf.baseY - scrollback;
    if (minLine <= 0) return;
    this.blocks = this.blocks.filter((b) => b.commandEndLine >= minLine);
  }

  /** Live-read output for a block from the terminal buffer. Fallback if outputText was not captured. */
  getBlockOutput(blockId: string): string | null {
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block) return null;
    if (block.outputText) return block.outputText;
    return this.extractOutput(block.commandStartLine + 1, block.commandEndLine);
  }

  /** Get current blocks (immutable snapshot). */
  getBlocks(): CommandBlock[] {
    return this.blocks;
  }

  /** Toggle collapse state for a block. */
  toggleCollapse(blockId: string): void {
    this.blocks = this.blocks.map((b) =>
      b.id === blockId ? { ...b, isCollapsed: !b.isCollapsed } : b
    );
    this.onChange(this.blocks);
  }

  /** Clean up handlers. */
  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.blocks = [];
  }
}

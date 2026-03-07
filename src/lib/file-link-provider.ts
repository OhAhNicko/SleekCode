import type { Terminal, ILinkProvider, ILink, IBufferLine } from "@xterm/xterm";

// Known source file extensions — keeps false positives low
const EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|sass|less|html|htm|xml|svg|" +
  "py|pyi|rb|go|rs|c|h|cpp|hpp|cc|java|kt|swift|sh|bash|zsh|fish|" +
  "yaml|yml|toml|ini|cfg|conf|env|lock|log|txt|csv|sql|graphql|gql|" +
  "vue|svelte|astro|prisma|dockerfile|makefile|cmake";

// Matches file paths with optional :line or :line:col or (line,col) suffix
//   Group 1: the file path
//   Group 2: line number (optional)
//   Group 3: col number (optional)
const FILE_PATH_RE = new RegExp(
  // Negative lookbehind: skip URL-scheme paths like http://
  "(?<![a-zA-Z]:\\/\\/)" +
    // The path itself: absolute (/...) or relative (./  ../  word/)
    "((?:\\.{0,2}/|[a-zA-Z0-9@_-]+/)" +
    // Path segments — directories + filename
    "(?:[a-zA-Z0-9._@/$-]+/)*" +
    // Final filename with known extension
    "[a-zA-Z0-9._@$-]+\\.(?:" + EXTENSIONS + "))" +
    // Optional line:col suffix
    "(?::(\\d+)(?::(\\d+))?|\\((\\d+),(\\d+)\\))?",
  "gi"
);

interface FileLinkMatch {
  text: string;
  filePath: string;
  line: number | undefined;
  col: number | undefined;
  startIndex: number;
  endIndex: number;
}

function findFilePathsInLine(lineText: string): FileLinkMatch[] {
  const matches: FileLinkMatch[] = [];
  FILE_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_PATH_RE.exec(lineText)) !== null) {
    const fullMatch = m[0];
    const filePath = m[1];
    // :line:col or (line,col)
    const line = m[2] ? parseInt(m[2], 10) : m[4] ? parseInt(m[4], 10) : undefined;
    const col = m[3] ? parseInt(m[3], 10) : m[5] ? parseInt(m[5], 10) : undefined;

    matches.push({
      text: fullMatch,
      filePath,
      line,
      col,
      startIndex: m.index,
      endIndex: m.index + fullMatch.length,
    });
  }
  return matches;
}

function getLineText(buffer: Terminal["buffer"]["active"], lineNumber: number): string {
  // lineNumber is 1-based from xterm
  const line: IBufferLine | undefined = buffer.getLine(lineNumber - 1);
  if (!line) return "";

  let text = line.translateToString(true);
  // Handle wrapped lines — append continuation lines
  let nextIdx = lineNumber; // 0-based index of next line
  while (nextIdx < buffer.length) {
    const nextLine = buffer.getLine(nextIdx);
    if (!nextLine || !nextLine.isWrapped) break;
    text += nextLine.translateToString(true);
    nextIdx++;
  }
  return text;
}

/**
 * Creates an ILinkProvider that detects file paths in terminal output
 * and opens them in the EzyDev file viewer on Ctrl+Click.
 */
export function createFilePathLinkProvider(
  term: Terminal,
  workingDir: string
): ILinkProvider {
  let activeTooltip: HTMLElement | null = null;

  function removeTooltip() {
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
    }
  }

  function resolvePath(filePath: string): string {
    if (filePath.startsWith("/")) return filePath;
    // Relative path — resolve against workingDir
    const base = workingDir.endsWith("/") ? workingDir : workingDir + "/";
    return base + filePath;
  }

  const provider: ILinkProvider = {
    provideLinks(lineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const lineText = getLineText(term.buffer.active, lineNumber);
      if (!lineText) {
        callback(undefined);
        return;
      }

      const matches = findFilePathsInLine(lineText);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }

      const links: ILink[] = matches.map((match) => ({
        range: {
          start: { x: match.startIndex + 1, y: lineNumber },
          end: { x: match.endIndex + 1, y: lineNumber },
        },
        text: match.text,
        decorations: {
          underline: true,
          pointerCursor: true,
        },
        activate(event: MouseEvent, _text: string): void {
          // Only activate on Ctrl+Click (or Cmd+Click on Mac)
          if (!event.ctrlKey && !event.metaKey) return;

          const resolved = resolvePath(match.filePath);
          window.dispatchEvent(
            new CustomEvent("ezydev:open-file", {
              detail: { filePath: resolved, lineNumber: match.line },
            })
          );
        },
        hover(event: MouseEvent, _text: string): void {
          removeTooltip();

          const tooltip = document.createElement("div");
          tooltip.className = "xterm-hover ezy-file-link-tooltip";
          tooltip.innerHTML =
            `<span class="ezy-flt-label">Open in EzyDev</span>` +
            `<kbd class="ezy-flt-kbd">${navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"}+Click</kbd>`;

          // Find the terminal container to position within
          const xtermEl = term.element;
          if (!xtermEl) return;
          const container = xtermEl.closest(".terminal-pane") ?? xtermEl.parentElement;
          if (!container) return;

          // Position near the mouse, clamped inside container
          const containerRect = container.getBoundingClientRect();
          tooltip.style.position = "fixed";
          tooltip.style.zIndex = "1000";

          // Place above the cursor by default
          let top = event.clientY - 36;
          let left = event.clientX;

          // Flip below if too close to top
          if (top < containerRect.top + 4) {
            top = event.clientY + 20;
          }
          // Clamp horizontal
          if (left + 180 > containerRect.right) {
            left = containerRect.right - 184;
          }
          if (left < containerRect.left) {
            left = containerRect.left + 4;
          }

          tooltip.style.top = `${top}px`;
          tooltip.style.left = `${left}px`;

          document.body.appendChild(tooltip);
          activeTooltip = tooltip;
        },
        leave(): void {
          removeTooltip();
        },
      }));

      callback(links);
    },
  };

  return provider;
}

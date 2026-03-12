import { useState, useEffect, useCallback, useRef } from "react";

interface MinesweeperGameProps {
  onAddTimedHighscore: (game: "minesweeperEasy" | "minesweeperMedium" | "minesweeperHard", seconds: number) => void;
  paused?: boolean;
}

type Difficulty = "easy" | "medium" | "hard";
type CellState = "hidden" | "revealed" | "flagged";
type GameState = "select" | "idle" | "playing" | "won" | "lost";

interface Cell {
  mine: boolean;
  count: number;
  state: CellState;
}

interface DifficultyConfig {
  rows: number;
  cols: number;
  mines: number;
  label: string;
  description: string;
  highscoreKey: "minesweeperEasy" | "minesweeperMedium" | "minesweeperHard";
}

const DIFFICULTIES: Record<Difficulty, DifficultyConfig> = {
  easy: { rows: 9, cols: 9, mines: 10, label: "Easy", description: "9 x 9, 10 mines", highscoreKey: "minesweeperEasy" },
  medium: { rows: 12, cols: 12, mines: 30, label: "Medium", description: "12 x 12, 30 mines", highscoreKey: "minesweeperMedium" },
  hard: { rows: 12, cols: 20, mines: 50, label: "Hard", description: "12 x 20, 50 mines", highscoreKey: "minesweeperHard" },
};

const NUMBER_COLORS: Record<number, string> = {
  1: "var(--ezy-accent)",
  2: "#4ade80",
  3: "#f87171",
  4: "var(--ezy-text-secondary)",
  5: "#f87171",
  6: "var(--ezy-accent)",
  7: "var(--ezy-text)",
  8: "var(--ezy-text-muted)",
};

function createBoard(rows: number, cols: number, mines: number): Cell[][] {
  const board: Cell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ mine: false, count: 0, state: "hidden" as CellState }))
  );

  // Place mines randomly
  let placed = 0;
  while (placed < mines) {
    const r = Math.floor(Math.random() * rows);
    const c = Math.floor(Math.random() * cols);
    if (!board[r][c].mine) {
      board[r][c].mine = true;
      placed++;
    }
  }

  // Calculate neighbor counts
  computeCounts(board, rows, cols);
  return board;
}

function computeCounts(board: Cell[][], rows: number, cols: number) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].mine) continue;
      let count = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].mine) {
            count++;
          }
        }
      }
      board[r][c].count = count;
    }
  }
}

function cloneBoard(board: Cell[][]): Cell[][] {
  return board.map((row) => row.map((cell) => ({ ...cell })));
}

function floodReveal(board: Cell[][], rows: number, cols: number, startR: number, startC: number) {
  const queue: [number, number][] = [[startR, startC]];
  while (queue.length > 0) {
    const [r, c] = queue.shift()!;
    if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
    if (board[r][c].state !== "hidden") continue;
    if (board[r][c].mine) continue;
    board[r][c].state = "revealed";
    if (board[r][c].count === 0) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          queue.push([r + dr, c + dc]);
        }
      }
    }
  }
}

function checkWin(board: Cell[][], rows: number, cols: number): boolean {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!board[r][c].mine && board[r][c].state !== "revealed") return false;
    }
  }
  return true;
}

function countFlags(board: Cell[][], rows: number, cols: number): number {
  let count = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].state === "flagged") count++;
    }
  }
  return count;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Inline SVG components (no emojis)
function MineIcon({ size, color }: { size: number; color: string }) {
  const r = size * 0.28;
  const lineLen = size * 0.42;
  const cx = size / 2;
  const cy = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
      <circle cx={cx} cy={cy} r={r} fill={color} />
      {/* 4 radiating lines: vertical, horizontal, diagonal */}
      <line x1={cx} y1={cy - lineLen} x2={cx} y2={cy + lineLen} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      <line x1={cx - lineLen} y1={cy} x2={cx + lineLen} y2={cy} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      <line x1={cx - lineLen * 0.7} y1={cy - lineLen * 0.7} x2={cx + lineLen * 0.7} y2={cy + lineLen * 0.7} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      <line x1={cx + lineLen * 0.7} y1={cy - lineLen * 0.7} x2={cx - lineLen * 0.7} y2={cy + lineLen * 0.7} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}

function FlagIcon({ size }: { size: number }) {
  // Small pennant/triangle flag
  const flagColor = "#f87171";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none">
      {/* Pole */}
      <line x1={size * 0.35} y1={size * 0.15} x2={size * 0.35} y2={size * 0.85} stroke={flagColor} strokeWidth={1.5} strokeLinecap="round" />
      {/* Pennant triangle */}
      <polygon
        points={`${size * 0.35},${size * 0.15} ${size * 0.78},${size * 0.32} ${size * 0.35},${size * 0.5}`}
        fill={flagColor}
      />
    </svg>
  );
}

export default function MinesweeperGame({ onAddTimedHighscore, paused = false }: MinesweeperGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gridAreaRef = useRef<HTMLDivElement>(null);

  const [difficulty, setDifficulty] = useState<Difficulty | null>(null);
  const [board, setBoard] = useState<Cell[][]>([]);
  const [gameState, setGameState] = useState<GameState>("select");
  const [elapsed, setElapsed] = useState(0);
  const [cursorR, setCursorR] = useState(0);
  const [cursorC, setCursorC] = useState(0);
  const [clickedMine, setClickedMine] = useState<[number, number] | null>(null);
  const [containerWidth, setContainerWidth] = useState(400);

  const gameStateRef = useRef<GameState>("select");
  const elapsedRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const firstClickRef = useRef(true);
  const boardRef = useRef<Cell[][]>([]);
  const difficultyRef = useRef<Difficulty | null>(null);

  // Keep refs in sync
  gameStateRef.current = gameState;
  boardRef.current = board;
  difficultyRef.current = difficulty;

  // ResizeObserver for grid area
  useEffect(() => {
    const el = gridAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Timer
  useEffect(() => {
    if (gameState === "playing" && !paused) {
      timerRef.current = setInterval(() => {
        elapsedRef.current += 1;
        setElapsed(elapsedRef.current);
      }, 1000);
    }
    return () => {
      if (timerRef.current !== undefined) {
        clearInterval(timerRef.current);
        timerRef.current = undefined;
      }
    };
  }, [gameState, paused]);

  const startGame = useCallback((diff: Difficulty) => {
    const cfg = DIFFICULTIES[diff];
    const newBoard = createBoard(cfg.rows, cfg.cols, cfg.mines);
    setDifficulty(diff);
    setBoard(newBoard);
    setGameState("idle");
    setElapsed(0);
    elapsedRef.current = 0;
    setCursorR(0);
    setCursorC(0);
    setClickedMine(null);
    firstClickRef.current = true;
  }, []);

  const handleReveal = useCallback((r: number, c: number) => {
    if (gameStateRef.current === "won" || gameStateRef.current === "lost") return;
    if (gameStateRef.current === "select") return;

    const diff = difficultyRef.current;
    if (!diff) return;
    const cfg = DIFFICULTIES[diff];
    let b = cloneBoard(boardRef.current);
    const cell = b[r][c];
    if (cell.state !== "hidden") return;

    // First click safety
    if (firstClickRef.current) {
      firstClickRef.current = false;
      if (cell.mine) {
        // Move the mine to a random empty cell
        cell.mine = false;
        let moved = false;
        while (!moved) {
          const nr = Math.floor(Math.random() * cfg.rows);
          const nc = Math.floor(Math.random() * cfg.cols);
          if (!b[nr][nc].mine && !(nr === r && nc === c)) {
            b[nr][nc].mine = true;
            moved = true;
          }
        }
        computeCounts(b, cfg.rows, cfg.cols);
      }
      setGameState("playing");
    }

    if (b[r][c].mine) {
      // Game over — reveal all mines
      for (let rr = 0; rr < cfg.rows; rr++) {
        for (let cc = 0; cc < cfg.cols; cc++) {
          if (b[rr][cc].mine) b[rr][cc].state = "revealed";
        }
      }
      setClickedMine([r, c]);
      setBoard(b);
      setGameState("lost");
      return;
    }

    // Flood fill for 0-count cells
    floodReveal(b, cfg.rows, cfg.cols, r, c);
    setBoard(b);

    if (checkWin(b, cfg.rows, cfg.cols)) {
      setGameState("won");
      onAddTimedHighscore(cfg.highscoreKey, elapsedRef.current);
    }
  }, [onAddTimedHighscore]);

  const handleFlag = useCallback((r: number, c: number) => {
    if (gameStateRef.current === "won" || gameStateRef.current === "lost") return;
    if (gameStateRef.current === "select") return;

    const b = cloneBoard(boardRef.current);
    const cell = b[r][c];
    if (cell.state === "revealed") return;
    cell.state = cell.state === "flagged" ? "hidden" : "flagged";
    setBoard(b);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (gameStateRef.current === "select") return;
    if (paused) return;

    const diff = difficultyRef.current;
    if (!diff) return;
    const cfg = DIFFICULTIES[diff];

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        setCursorR((prev) => Math.max(0, prev - 1));
        break;
      case "ArrowDown":
        e.preventDefault();
        setCursorR((prev) => Math.min(cfg.rows - 1, prev + 1));
        break;
      case "ArrowLeft":
        e.preventDefault();
        setCursorC((prev) => Math.max(0, prev - 1));
        break;
      case "ArrowRight":
        e.preventDefault();
        setCursorC((prev) => Math.min(cfg.cols - 1, prev + 1));
        break;
      case "Enter":
        e.preventDefault();
        handleReveal(cursorR, cursorC);
        break;
      case "f":
      case "F":
        e.preventDefault();
        handleFlag(cursorR, cursorC);
        break;
    }
  }, [paused, cursorR, cursorC, handleReveal, handleFlag]);

  const handleNewGame = useCallback(() => {
    if (difficulty) startGame(difficulty);
  }, [difficulty, startGame]);

  const handleBackToSelect = useCallback(() => {
    setGameState("select");
    setDifficulty(null);
    setBoard([]);
    setElapsed(0);
    elapsedRef.current = 0;
    setClickedMine(null);
    if (timerRef.current !== undefined) {
      clearInterval(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  // Difficulty selector screen
  if (gameState === "select") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          width: "100%",
          backgroundColor: "var(--ezy-bg)",
          fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 12,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ezy-text)", marginBottom: 8 }}>
          Select Difficulty
        </div>
        {(["easy", "medium", "hard"] as Difficulty[]).map((diff) => {
          const cfg = DIFFICULTIES[diff];
          return (
            <div
              key={diff}
              onClick={() => startGame(diff)}
              style={{
                width: "100%",
                maxWidth: 260,
                padding: "12px 16px",
                borderRadius: 6,
                backgroundColor: "var(--ezy-surface)",
                border: "1px solid var(--ezy-border)",
                cursor: "pointer",
                transition: "background-color 150ms ease, border-color 150ms ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)";
                e.currentTarget.style.borderColor = "var(--ezy-accent)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
                e.currentTarget.style.borderColor = "var(--ezy-border)";
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>{cfg.label}</div>
              <div style={{ fontSize: 11, color: "var(--ezy-text-secondary)", marginTop: 2 }}>{cfg.description}</div>
            </div>
          );
        })}
      </div>
    );
  }

  const cfg = difficulty ? DIFFICULTIES[difficulty] : null;
  if (!cfg) return null;

  const cellSize = Math.max(20, Math.min(32, Math.floor((containerWidth - 4) / cfg.cols)));
  const flags = countFlags(board, cfg.rows, cfg.cols);
  const minesRemaining = cfg.mines - flags;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        backgroundColor: "var(--ezy-bg)",
        outline: "none",
        fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)",
      }}
    >
      {/* Score bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--ezy-text-secondary)",
          borderBottom: "1px solid var(--ezy-border)",
          fontVariantNumeric: "tabular-nums",
          padding: "6px 12px",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Mine count */}
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <MineIcon size={14} color="var(--ezy-text-secondary)" />
            <span>{minesRemaining}</span>
          </div>
          {/* Timer */}
          <span>{formatTime(elapsed)}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            onClick={handleNewGame}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ezy-text-muted)",
              cursor: "pointer",
              padding: "2px 8px",
              borderRadius: 4,
              transition: "color 120ms ease",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ezy-text)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")}
          >
            New Game
          </div>
          <div
            onClick={handleBackToSelect}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ezy-text-muted)",
              cursor: "pointer",
              padding: "2px 8px",
              borderRadius: 4,
              transition: "color 120ms ease",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ezy-text)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")}
          >
            Difficulty
          </div>
        </div>
      </div>

      {/* Grid area */}
      <div
        ref={gridAreaRef}
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          position: "relative",
          padding: 4,
        }}
      >
        {/* Board grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${cfg.cols}, ${cellSize}px)`,
            gridTemplateRows: `repeat(${cfg.rows}, ${cellSize}px)`,
            gap: 0,
          }}
        >
          {board.map((row, r) =>
            row.map((cell, c) => {
              const isRevealed = cell.state === "revealed";
              const isFlagged = cell.state === "flagged";
              const isCursor = r === cursorR && c === cursorC;
              const isClickedMine = clickedMine && clickedMine[0] === r && clickedMine[1] === c;

              let bg = "var(--ezy-surface-raised)";
              if (isRevealed) {
                bg = isClickedMine ? "#7f1d1d" : "var(--ezy-bg)";
              }

              return (
                <div
                  key={`${r}-${c}`}
                  onClick={() => {
                    if (!paused) handleReveal(r, c);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!paused) handleFlag(r, c);
                  }}
                  style={{
                    width: cellSize,
                    height: cellSize,
                    backgroundColor: bg,
                    border: isRevealed
                      ? "1px solid rgba(255,255,255,0.04)"
                      : "1px solid var(--ezy-border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: isRevealed ? "default" : "pointer",
                    outline: isCursor ? "2px solid var(--ezy-accent)" : "none",
                    outlineOffset: -2,
                    fontSize: Math.max(10, cellSize * 0.45),
                    fontWeight: 700,
                    userSelect: "none",
                    transition: "background-color 80ms ease",
                    position: "relative",
                    zIndex: isCursor ? 1 : 0,
                  }}
                  onMouseEnter={(e) => {
                    if (!isRevealed) {
                      e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isRevealed) {
                      e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)";
                    }
                  }}
                >
                  {isRevealed && cell.mine && (
                    <MineIcon size={Math.max(12, cellSize * 0.6)} color={isClickedMine ? "#f87171" : "var(--ezy-text)"} />
                  )}
                  {isRevealed && !cell.mine && cell.count > 0 && (
                    <span style={{ color: NUMBER_COLORS[cell.count] || "var(--ezy-text)" }}>
                      {cell.count}
                    </span>
                  )}
                  {isFlagged && (
                    <FlagIcon size={Math.max(12, cellSize * 0.6)} />
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Pause overlay */}
        {paused && gameState !== "won" && gameState !== "lost" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10,
            }}
          >
            <span style={{ fontSize: 18, fontWeight: 700, color: "var(--ezy-text)" }}>Paused</span>
          </div>
        )}

        {/* Game over / win overlay */}
        {(gameState === "won" || gameState === "lost") && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor: "rgba(0,0,0,0.75)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              zIndex: 10,
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, color: gameState === "won" ? "#4ade80" : "#f87171" }}>
              {gameState === "won" ? "You Win!" : "Game Over"}
            </div>
            {gameState === "won" && (
              <div style={{ fontSize: 13, color: "var(--ezy-text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                Time: {formatTime(elapsed)}
              </div>
            )}
            <div
              onClick={handleNewGame}
              style={{
                fontSize: 13,
                fontWeight: 600,
                padding: "8px 20px",
                borderRadius: 6,
                backgroundColor: "var(--ezy-accent)",
                color: "var(--ezy-bg)",
                cursor: "pointer",
                transition: "opacity 120ms ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
            >
              Play Again
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

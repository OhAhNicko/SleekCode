import { useState, useEffect, useCallback, useRef } from "react";

interface Game2048Props {
  onAddHighscore: (score: number) => void;
}

type Board = (number | null)[][];

// Neutral/cool tile palette — no amber/yellow/blue
const TILE_STYLES: Record<number, { bg: string; fg: string }> = {
  2:    { bg: "#2a2a2a", fg: "#a3a3a3" },
  4:    { bg: "#333333", fg: "#b5b5b5" },
  8:    { bg: "#3d3d3d", fg: "#d4d4d4" },
  16:   { bg: "#474747", fg: "#e5e5e5" },
  32:   { bg: "#525252", fg: "#f0f0f0" },
  64:   { bg: "#5c5c5c", fg: "#fafafa" },
  128:  { bg: "#656565", fg: "#ffffff" },
  256:  { bg: "#737373", fg: "#ffffff" },
  512:  { bg: "#858585", fg: "#ffffff" },
  1024: { bg: "#969696", fg: "#ffffff" },
  2048: { bg: "var(--ezy-accent)", fg: "#000000" },
  4096: { bg: "#f87171", fg: "#ffffff" },
  8192: { bg: "#34d399", fg: "#000000" },
};

function getTileStyle(val: number): { bg: string; fg: string } {
  return TILE_STYLES[val] || { bg: "#a3a3a3", fg: "#000000" };
}

function createEmptyBoard(): Board {
  return Array.from({ length: 4 }, () => Array(4).fill(null));
}

function addRandomTile(board: Board): Board {
  const empty: [number, number][] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (board[r][c] === null) empty.push([r, c]);
    }
  }
  if (empty.length === 0) return board;
  const [r, c] = empty[Math.floor(Math.random() * empty.length)];
  const newBoard = board.map((row) => [...row]);
  newBoard[r][c] = Math.random() < 0.9 ? 2 : 4;
  return newBoard;
}

function slideRow(row: (number | null)[]): { result: (number | null)[]; score: number } {
  const nums = row.filter((v): v is number => v !== null);
  const merged: number[] = [];
  let score = 0;
  let i = 0;
  while (i < nums.length) {
    if (i + 1 < nums.length && nums[i] === nums[i + 1]) {
      const val = nums[i] * 2;
      merged.push(val);
      score += val;
      i += 2;
    } else {
      merged.push(nums[i]);
      i++;
    }
  }
  while (merged.length < 4) merged.push(null as unknown as number);
  return { result: merged.map((v) => (v === 0 ? null : v)) as (number | null)[], score };
}

function move(board: Board, direction: "up" | "down" | "left" | "right"): { board: Board; score: number; moved: boolean } {
  let totalScore = 0;
  const newBoard = createEmptyBoard();
  let moved = false;

  for (let i = 0; i < 4; i++) {
    let line: (number | null)[];
    switch (direction) {
      case "left":
        line = board[i].slice();
        break;
      case "right":
        line = board[i].slice().reverse();
        break;
      case "up":
        line = [board[0][i], board[1][i], board[2][i], board[3][i]];
        break;
      case "down":
        line = [board[3][i], board[2][i], board[1][i], board[0][i]];
        break;
    }

    const { result, score } = slideRow(line);
    totalScore += score;

    let output = result;
    if (direction === "right" || direction === "down") {
      output = result.slice().reverse();
    }

    for (let j = 0; j < 4; j++) {
      switch (direction) {
        case "left":
        case "right":
          newBoard[i][j] = output[j];
          if (output[j] !== board[i][j]) moved = true;
          break;
        case "up":
        case "down":
          newBoard[j][i] = output[j];
          if (output[j] !== board[j][i]) moved = true;
          break;
      }
    }
  }

  return { board: newBoard, score: totalScore, moved };
}

function canMove(board: Board): boolean {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (board[r][c] === null) return true;
      if (c < 3 && board[r][c] === board[r][c + 1]) return true;
      if (r < 3 && board[r][c] === board[r + 1][c]) return true;
    }
  }
  return false;
}

export default function Game2048({ onAddHighscore }: Game2048Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState<Board>(() => {
    let b = createEmptyBoard();
    b = addRandomTile(b);
    b = addRandomTile(b);
    return b;
  });
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [containerWidth, setContainerWidth] = useState(300);

  // Resize observer for responsive tile sizing
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const resetGame = useCallback(() => {
    let b = createEmptyBoard();
    b = addRandomTile(b);
    b = addRandomTile(b);
    setBoard(b);
    setScore(0);
    setGameOver(false);
  }, []);

  const handleMove = useCallback(
    (direction: "up" | "down" | "left" | "right") => {
      if (gameOver) return;
      const { board: newBoard, score: gained, moved } = move(board, direction);
      if (!moved) return;

      const withNew = addRandomTile(newBoard);
      const newScore = score + gained;
      setBoard(withNew);
      setScore(newScore);

      if (!canMove(withNew)) {
        setGameOver(true);
        if (newScore > 0) onAddHighscore(newScore);
        setBestScore((prev) => Math.max(prev, newScore));
      }
    },
    [board, score, gameOver, onAddHighscore]
  );

  // Keyboard
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp": case "w": case "W":
          e.preventDefault(); handleMove("up"); break;
        case "ArrowDown": case "s": case "S":
          e.preventDefault(); handleMove("down"); break;
        case "ArrowLeft": case "a": case "A":
          e.preventDefault(); handleMove("left"); break;
        case "ArrowRight": case "d": case "D":
          e.preventDefault(); handleMove("right"); break;
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [handleMove]);

  // Auto-focus
  useEffect(() => { containerRef.current?.focus(); }, [gameOver]);

  // Compute tile size to fit container
  const gap = 6;
  const padding = 8;
  const availableWidth = containerWidth - padding * 2 - gap * 3;
  const tileSize = Math.max(32, Math.min(80, Math.floor(availableWidth / 4)));
  const gridPx = tileSize * 4 + gap * 3 + padding * 2;

  const tileFontSize = tileSize < 40 ? 12 : tileSize < 55 ? 16 : 20;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      style={{
        width: "100%",
        height: "100%",
        outline: "none",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--ezy-bg)",
      }}
    >
      {/* Score bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 12px",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--ezy-text-secondary)",
          borderBottom: "1px solid var(--ezy-border)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>Score: <span style={{ color: "var(--ezy-accent)" }}>{score}</span></span>
        {bestScore > 0 && <span>Best: {bestScore}</span>}
        <button
          onClick={resetGame}
          style={{
            padding: "3px 10px",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--ezy-text-secondary)",
            backgroundColor: "var(--ezy-surface)",
            border: "1px solid var(--ezy-border)",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          New
        </button>
      </div>

      {/* Board */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(4, ${tileSize}px)`,
            gridTemplateRows: `repeat(4, ${tileSize}px)`,
            gap,
            padding,
            backgroundColor: "var(--ezy-surface)",
            borderRadius: 8,
            width: gridPx,
          }}
        >
          {board.flatMap((row, r) =>
            row.map((val, c) => {
              const style = val ? getTileStyle(val) : { bg: "var(--ezy-bg)", fg: "transparent" };
              return (
                <div
                  key={`${r}-${c}`}
                  style={{
                    width: tileSize,
                    height: tileSize,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: style.bg,
                    color: style.fg,
                    fontSize: tileFontSize,
                    fontWeight: 700,
                    borderRadius: 4,
                    transition: "background-color 100ms ease",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {val || ""}
                </div>
              );
            })
          )}
        </div>

        {/* Game over overlay */}
        {gameOver && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(0,0,0,0.7)",
              gap: 12,
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ezy-text)" }}>Game Over</div>
            <div style={{ fontSize: 14, color: "var(--ezy-accent)", fontWeight: 600 }}>Score: {score}</div>
            {score > 0 && score >= bestScore && (
              <div style={{ fontSize: 12, color: "#4ade80", fontWeight: 600 }}>New Highscore!</div>
            )}
            <button
              onClick={() => {
                resetGame();
                setTimeout(() => containerRef.current?.focus(), 50);
              }}
              style={{
                padding: "8px 24px",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--ezy-bg)",
                backgroundColor: "var(--ezy-accent)",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              Play Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback, useRef, useMemo } from "react";

interface TicTacToeGameProps {
  onUpdateStats: (variant: "3x3" | "5x5", result: "win" | "loss" | "draw") => void;
  paused?: boolean;
}

type Variant = "3x3" | "5x5";
type Difficulty = "easy" | "medium" | "impossible";
type Cell = "X" | "O" | null;
type Board = Cell[];

// ─── Constants ───────────────────────────────────────────────────────

const FONT_UI = "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)";
const COLOR_X = "var(--ezy-accent)";
const COLOR_O = "#f87171";

// ─── Win detection ───────────────────────────────────────────────────

function getWinLines3(): number[][] {
  const lines: number[][] = [];
  for (let i = 0; i < 3; i++) {
    lines.push([i * 3, i * 3 + 1, i * 3 + 2]); // rows
    lines.push([i, i + 3, i + 6]); // cols
  }
  lines.push([0, 4, 8], [2, 4, 6]); // diags
  return lines;
}

function getWinLines5(): number[][] {
  const lines: number[][] = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c <= 1; c++) {
      lines.push([r * 5 + c, r * 5 + c + 1, r * 5 + c + 2, r * 5 + c + 3]);
    }
  }
  for (let c = 0; c < 5; c++) {
    for (let r = 0; r <= 1; r++) {
      lines.push([r * 5 + c, (r + 1) * 5 + c, (r + 2) * 5 + c, (r + 3) * 5 + c]);
    }
  }
  for (let r = 0; r <= 1; r++) {
    for (let c = 0; c <= 1; c++) {
      const idx = r * 5 + c;
      lines.push([idx, idx + 6, idx + 12, idx + 18]);
    }
  }
  for (let r = 0; r <= 1; r++) {
    for (let c = 3; c < 5; c++) {
      const idx = r * 5 + c;
      lines.push([idx, idx + 4, idx + 8, idx + 12]);
    }
  }
  return lines;
}

const WIN_LINES_3 = getWinLines3();
const WIN_LINES_5 = getWinLines5();

function checkWinner(board: Board, size: number): { winner: Cell; line: number[] | null } {
  const lines = size === 3 ? WIN_LINES_3 : WIN_LINES_5;
  for (const line of lines) {
    const first = board[line[0]];
    if (first && line.every((idx) => board[idx] === first)) {
      return { winner: first, line };
    }
  }
  return { winner: null, line: null };
}

function isFull(board: Board): boolean {
  return board.every((c) => c !== null);
}

// ─── 3x3 AI ─────────────────────────────────────────────────────────

function aiEasy(board: Board): number {
  const empty = board.map((c, i) => (c === null ? i : -1)).filter((i) => i >= 0);
  return empty[Math.floor(Math.random() * empty.length)];
}

function aiMedium(board: Board): number {
  // Try to win
  for (const line of WIN_LINES_3) {
    const cells = line.map((i) => board[i]);
    if (cells.filter((c) => c === "O").length === 2 && cells.filter((c) => c === null).length === 1) {
      return line[cells.indexOf(null)];
    }
  }
  // Block opponent win
  for (const line of WIN_LINES_3) {
    const cells = line.map((i) => board[i]);
    if (cells.filter((c) => c === "X").length === 2 && cells.filter((c) => c === null).length === 1) {
      return line[cells.indexOf(null)];
    }
  }
  // Prefer center, then corners, then random
  if (board[4] === null) return 4;
  const corners = [0, 2, 6, 8].filter((i) => board[i] === null);
  if (corners.length > 0) return corners[Math.floor(Math.random() * corners.length)];
  return aiEasy(board);
}

function minimax3(board: Board, isMaximizing: boolean): number {
  const { winner } = checkWinner(board, 3);
  if (winner === "O") return 10;
  if (winner === "X") return -10;
  if (isFull(board)) return 0;

  if (isMaximizing) {
    let best = -Infinity;
    for (let i = 0; i < 9; i++) {
      if (board[i] === null) {
        board[i] = "O";
        best = Math.max(best, minimax3(board, false));
        board[i] = null;
      }
    }
    return best;
  } else {
    let best = Infinity;
    for (let i = 0; i < 9; i++) {
      if (board[i] === null) {
        board[i] = "X";
        best = Math.min(best, minimax3(board, true));
        board[i] = null;
      }
    }
    return best;
  }
}

function aiImpossible(board: Board): number {
  let bestScore = -Infinity;
  let bestMove = -1;
  for (let i = 0; i < 9; i++) {
    if (board[i] === null) {
      board[i] = "O";
      const score = minimax3(board, false);
      board[i] = null;
      if (score > bestScore) {
        bestScore = score;
        bestMove = i;
      }
    }
  }
  return bestMove;
}

// ─── 5x5 AI (alpha-beta with depth limit) ───────────────────────────

function evaluate5(board: Board): number {
  let score = 0;
  for (const line of WIN_LINES_5) {
    let oCount = 0;
    let xCount = 0;
    for (const idx of line) {
      if (board[idx] === "O") oCount++;
      else if (board[idx] === "X") xCount++;
    }
    if (oCount === 4) return 100000;
    if (xCount === 4) return -100000;
    if (xCount === 0 && oCount > 0) {
      score += oCount * oCount * 10;
    }
    if (oCount === 0 && xCount > 0) {
      score -= xCount * xCount * 10;
    }
  }
  return score;
}

function getOrderedMoves5(board: Board): number[] {
  const empty: number[] = [];
  for (let i = 0; i < 25; i++) {
    if (board[i] === null) empty.push(i);
  }
  // Score each move: prefer center, then adjacency to existing pieces
  const center = 12;
  const scores: { idx: number; score: number }[] = empty.map((idx) => {
    let s = 0;
    const r = Math.floor(idx / 5);
    const c = idx % 5;
    // Distance from center
    const dr = Math.abs(r - 2);
    const dc = Math.abs(c - 2);
    s -= (dr + dc) * 2;
    // Adjacent to existing pieces
    for (const [ar, ac] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const nr = r + ar;
      const nc = c + ac;
      if (nr >= 0 && nr < 5 && nc >= 0 && nc < 5 && board[nr * 5 + nc] !== null) {
        s += 3;
      }
    }
    if (idx === center) s += 5;
    return { idx, score: s };
  });
  scores.sort((a, b) => b.score - a.score);
  return scores.map((s) => s.idx);
}

function alphaBeta5(board: Board, depth: number, alpha: number, beta: number, isMaximizing: boolean): number {
  const { winner } = checkWinner(board, 5);
  if (winner === "O") return 100000 + depth;
  if (winner === "X") return -100000 - depth;
  if (isFull(board)) return 0;
  if (depth === 0) return evaluate5(board);

  const moves = getOrderedMoves5(board);

  if (isMaximizing) {
    let value = -Infinity;
    for (const idx of moves) {
      board[idx] = "O";
      value = Math.max(value, alphaBeta5(board, depth - 1, alpha, beta, false));
      board[idx] = null;
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break;
    }
    return value;
  } else {
    let value = Infinity;
    for (const idx of moves) {
      board[idx] = "X";
      value = Math.min(value, alphaBeta5(board, depth - 1, alpha, beta, true));
      board[idx] = null;
      beta = Math.min(beta, value);
      if (alpha >= beta) break;
    }
    return value;
  }
}

function ai5x5(board: Board): number {
  let bestScore = -Infinity;
  let bestMove = -1;
  const moves = getOrderedMoves5(board);
  for (const idx of moves) {
    board[idx] = "O";
    const score = alphaBeta5(board, 4, -Infinity, Infinity, false);
    board[idx] = null;
    if (score > bestScore) {
      bestScore = score;
      bestMove = idx;
    }
  }
  return bestMove;
}

// ─── Component ───────────────────────────────────────────────────────

export default function TicTacToeGame({ onUpdateStats, paused = false }: TicTacToeGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [variant, setVariant] = useState<Variant | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty | null>(null);
  const [board, setBoard] = useState<Board>([]);
  const [currentTurn, setCurrentTurn] = useState<"X" | "O">("X");
  const [winner, setWinner] = useState<Cell>(null);
  const [winLine, setWinLine] = useState<number[] | null>(null);
  const [isDraw, setIsDraw] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [containerSize, setContainerSize] = useState({ width: 300, height: 300 });
  const [scores, setScores] = useState({ wins: 0, losses: 0, draws: 0 });
  const aiRunningRef = useRef(false);

  const size = variant === "3x3" ? 3 : variant === "5x5" ? 5 : 0;


  // ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cellSize = useMemo(() => {
    if (size === 0) return 60;
    const maxBoardWidth = containerSize.width - 32;
    const maxBoardHeight = containerSize.height - 100; // reserve space for score bar + overlay
    const maxDim = Math.min(maxBoardWidth, maxBoardHeight);
    const gap = size === 3 ? 6 : 4;
    const totalGap = (size - 1) * gap;
    return Math.max(28, Math.min(120, Math.floor((maxDim - totalGap) / size)));
  }, [containerSize, size]);

  const startGame = useCallback((v: Variant, _d: Difficulty | null) => {
    const s = v === "3x3" ? 9 : 25;
    setBoard(Array(s).fill(null));
    setCurrentTurn("X");
    setWinner(null);
    setWinLine(null);
    setIsDraw(false);
    setCursor(Math.floor(s / 2));
    aiRunningRef.current = false;
  }, []);

  const handleSelectVariant = useCallback((v: Variant) => {
    setVariant(v);
    if (v === "5x5") {
      setDifficulty(null); // 5x5 uses fixed alpha-beta
      startGame(v, null);
    }
  }, [startGame]);

  const handleSelectDifficulty = useCallback((d: Difficulty) => {
    setDifficulty(d);
    startGame("3x3", d);
  }, [startGame]);

  const playAgain = useCallback(() => {
    if (variant) startGame(variant, difficulty);
  }, [variant, difficulty, startGame]);

  // AI move
  const makeAiMove = useCallback((currentBoard: Board) => {
    if (aiRunningRef.current) return;
    aiRunningRef.current = true;

    const boardCopy = [...currentBoard];
    let move = -1;

    if (variant === "3x3") {
      switch (difficulty) {
        case "easy":
          move = aiEasy(boardCopy);
          break;
        case "medium":
          move = aiMedium(boardCopy);
          break;
        case "impossible":
          move = aiImpossible(boardCopy);
          break;
      }
    } else {
      move = ai5x5(boardCopy);
    }

    if (move < 0) {
      aiRunningRef.current = false;
      return;
    }

    // Small delay to feel natural
    setTimeout(() => {
      setBoard((prev) => {
        if (prev[move] !== null) {
          aiRunningRef.current = false;
          return prev;
        }
        const next = [...prev];
        next[move] = "O";

        const s = variant === "3x3" ? 3 : 5;
        const { winner: w, line } = checkWinner(next, s);
        if (w) {
          setWinner(w);
          setWinLine(line);
          if (w === "O") {
            setScores((sc) => ({ ...sc, losses: sc.losses + 1 }));
            if (variant) onUpdateStats(variant, "loss");
          }
        } else if (isFull(next)) {
          setIsDraw(true);
          setScores((sc) => ({ ...sc, draws: sc.draws + 1 }));
          if (variant) onUpdateStats(variant, "draw");
        } else {
          setCurrentTurn("X");
        }

        aiRunningRef.current = false;
        return next;
      });
    }, 250);
  }, [variant, difficulty, onUpdateStats]);

  // Trigger AI when it's O's turn
  useEffect(() => {
    if (currentTurn === "O" && !winner && !isDraw && !paused && board.length > 0) {
      makeAiMove(board);
    }
  }, [currentTurn, winner, isDraw, paused, board, makeAiMove]);

  const handleCellClick = useCallback((index: number) => {
    if (paused || winner || isDraw || currentTurn !== "X" || board[index] !== null) return;

    const next = [...board];
    next[index] = "X";
    setBoard(next);
    setCursor(index);

    const { winner: w, line } = checkWinner(next, size);
    if (w) {
      setWinner(w);
      setWinLine(line);
      if (w === "X") {
        setScores((sc) => ({ ...sc, wins: sc.wins + 1 }));
        if (variant) onUpdateStats(variant, "win");
      }
    } else if (isFull(next)) {
      setIsDraw(true);
      setScores((sc) => ({ ...sc, draws: sc.draws + 1 }));
      if (variant) onUpdateStats(variant, "draw");
    } else {
      setCurrentTurn("O");
    }
  }, [paused, winner, isDraw, currentTurn, board, size, variant, onUpdateStats]);

  // Keyboard navigation
  useEffect(() => {
    const el = containerRef.current;
    if (!el || size === 0) return;

    const handler = (e: KeyboardEvent) => {
      if (paused || winner || isDraw) return;

      const row = Math.floor(cursor / size);
      const col = cursor % size;

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          if (row > 0) setCursor((row - 1) * size + col);
          break;
        case "ArrowDown":
          e.preventDefault();
          if (row < size - 1) setCursor((row + 1) * size + col);
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (col > 0) setCursor(row * size + (col - 1));
          break;
        case "ArrowRight":
          e.preventDefault();
          if (col < size - 1) setCursor(row * size + (col + 1));
          break;
        case "Enter":
          e.preventDefault();
          handleCellClick(cursor);
          break;
      }
    };

    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [cursor, size, paused, winner, isDraw, handleCellClick]);

  const gameOver = winner !== null || isDraw;
  const gap = size === 3 ? 6 : 4;

  // ─── Render: Variant selector ──────────────────────────────────────

  if (!variant) {
    return (
      <div
        ref={containerRef}
        tabIndex={0}
        style={{
          outline: "none",
          backgroundColor: "var(--ezy-bg)",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          fontFamily: FONT_UI,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ezy-text)", marginBottom: 4 }}>
          Select Mode
        </div>
        {(["3x3", "5x5"] as Variant[]).map((v) => (
          <div
            key={v}
            onClick={() => handleSelectVariant(v)}
            style={{
              width: 200,
              padding: "14px 16px",
              borderRadius: 6,
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              cursor: "pointer",
              textAlign: "center",
              transition: "background-color 150ms ease, border-color 150ms ease",
              fontFamily: FONT_UI,
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
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>
              {v === "3x3" ? "Classic 3x3" : "5x5 (First to 4)"}
            </div>
            <div style={{ fontSize: 11, color: "var(--ezy-text-secondary)", marginTop: 4 }}>
              {v === "3x3" ? "Three difficulty levels" : "Alpha-beta AI opponent"}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ─── Render: Difficulty selector (3x3 only) ───────────────────────

  if (variant === "3x3" && difficulty === null) {
    return (
      <div
        ref={containerRef}
        tabIndex={0}
        style={{
          outline: "none",
          backgroundColor: "var(--ezy-bg)",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          fontFamily: FONT_UI,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ezy-text)", marginBottom: 4 }}>
          Select Difficulty
        </div>
        {([
          { key: "easy" as Difficulty, label: "Easy", desc: "Random moves" },
          { key: "medium" as Difficulty, label: "Medium", desc: "Blocks and takes wins" },
          { key: "impossible" as Difficulty, label: "Impossible", desc: "Perfect play (minimax)" },
        ]).map((d) => (
          <div
            key={d.key}
            onClick={() => handleSelectDifficulty(d.key)}
            style={{
              width: 200,
              padding: "12px 16px",
              borderRadius: 6,
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              cursor: "pointer",
              textAlign: "center",
              transition: "background-color 150ms ease, border-color 150ms ease",
              fontFamily: FONT_UI,
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
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>{d.label}</div>
            <div style={{ fontSize: 11, color: "var(--ezy-text-secondary)", marginTop: 3 }}>{d.desc}</div>
          </div>
        ))}
      </div>
    );
  }

  // ─── Render: Game board ────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      style={{
        outline: "none",
        backgroundColor: "var(--ezy-bg)",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        fontFamily: FONT_UI,
      }}
    >
      {/* Score bar */}
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--ezy-text-secondary)",
          borderBottom: "1px solid var(--ezy-border)",
          fontVariantNumeric: "tabular-nums",
          padding: "6px 12px",
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexShrink: 0,
        }}
      >
        <span style={{ color: COLOR_X }}>W {scores.wins}</span>
        <span style={{ color: COLOR_O }}>L {scores.losses}</span>
        <span style={{ color: "var(--ezy-text-muted)" }}>D {scores.draws}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>
          {variant === "3x3" ? `3x3 ${difficulty}` : "5x5"}
        </span>
      </div>

      {/* Board area */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${size}, ${cellSize}px)`,
            gridTemplateRows: `repeat(${size}, ${cellSize}px)`,
            gap,
          }}
        >
          {board.map((cell, idx) => {
            const isWinCell = winLine !== null && winLine.includes(idx);
            const isCursorCell = idx === cursor && !gameOver;

            return (
              <div
                key={idx}
                onClick={() => handleCellClick(idx)}
                style={{
                  width: cellSize,
                  height: cellSize,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: isWinCell
                    ? "var(--ezy-surface-raised)"
                    : "var(--ezy-surface)",
                  border: isCursorCell
                    ? "2px solid var(--ezy-accent)"
                    : "1px solid var(--ezy-border)",
                  borderRadius: 4,
                  cursor: cell === null && currentTurn === "X" && !gameOver ? "pointer" : "default",
                  transition: "background-color 120ms ease, border-color 120ms ease",
                  fontSize: Math.max(16, cellSize * 0.45),
                  fontWeight: 700,
                  color: cell === "X" ? COLOR_X : cell === "O" ? COLOR_O : "transparent",
                  userSelect: "none",
                  fontFamily: FONT_UI,
                }}
                onMouseEnter={(e) => {
                  if (cell === null && currentTurn === "X" && !gameOver && !paused) {
                    e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isWinCell) {
                    e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
                  }
                }}
              >
                {cell ?? ""}
              </div>
            );
          })}
        </div>

        {/* Turn indicator (below grid, non-overlapping) — only shown during play */}
        {!gameOver && !paused && (
          <div
            style={{
              position: "absolute",
              bottom: 12,
              left: 0,
              right: 0,
              textAlign: "center",
              fontSize: 12,
              color: currentTurn === "X" ? COLOR_X : COLOR_O,
              fontWeight: 600,
              fontFamily: FONT_UI,
            }}
          >
            {currentTurn === "X" ? "Your turn" : "AI thinking..."}
          </div>
        )}

        {/* Game over overlay */}
        {gameOver && !paused && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor: "rgba(0,0,0,0.75)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 16,
              zIndex: 10,
            }}
          >
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                color: winner === "X" ? COLOR_X : winner === "O" ? COLOR_O : "var(--ezy-text)",
                fontFamily: FONT_UI,
              }}
            >
              {winner === "X" ? "You Win!" : winner === "O" ? "You Lose" : "Draw"}
            </div>
            <div
              onClick={playAgain}
              style={{
                padding: "8px 24px",
                borderRadius: 6,
                backgroundColor: "var(--ezy-accent)",
                color: "var(--ezy-bg)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: FONT_UI,
                transition: "opacity 120ms ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
            >
              Play Again
            </div>
          </div>
        )}

        {/* Pause overlay */}
        {paused && (
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
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: "var(--ezy-text)",
                fontFamily: FONT_UI,
              }}
            >
              Paused
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

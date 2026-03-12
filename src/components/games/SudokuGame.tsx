import { useState, useEffect, useCallback, useRef } from "react";

interface SudokuGameProps {
  onAddHighscore: (score: number) => void;
}

type Grid = (number | null)[][];
type Difficulty = "easy" | "medium" | "hard";

const DIFFICULTY_CLUES: Record<Difficulty, number> = { easy: 40, medium: 30, hard: 25 };
const DIFFICULTY_MULT: Record<Difficulty, number> = { easy: 1, medium: 2, hard: 3 };

// --- Sudoku Generator ---

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isValidPlacement(grid: Grid, row: number, col: number, num: number): boolean {
  for (let c = 0; c < 9; c++) if (grid[row][c] === num) return false;
  for (let r = 0; r < 9; r++) if (grid[r][col] === num) return false;
  const br = Math.floor(row / 3) * 3;
  const bc = Math.floor(col / 3) * 3;
  for (let r = br; r < br + 3; r++) {
    for (let c = bc; c < bc + 3; c++) {
      if (grid[r][c] === num) return false;
    }
  }
  return true;
}

function solveSudoku(grid: Grid): boolean {
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (grid[r][c] === null) {
        const nums = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        for (const num of nums) {
          if (isValidPlacement(grid, r, c, num)) {
            grid[r][c] = num;
            if (solveSudoku(grid)) return true;
            grid[r][c] = null;
          }
        }
        return false;
      }
    }
  }
  return true;
}

function generatePuzzle(clueCount: number): { puzzle: Grid; solution: Grid } {
  const solution: Grid = Array.from({ length: 9 }, () => Array(9).fill(null));
  solveSudoku(solution);

  const puzzle: Grid = solution.map((row) => [...row]);
  const cells = shuffle(
    Array.from({ length: 81 }, (_, i) => [Math.floor(i / 9), i % 9] as [number, number])
  );

  let removed = 0;
  const toRemove = 81 - clueCount;
  for (const [r, c] of cells) {
    if (removed >= toRemove) break;
    puzzle[r][c] = null;
    removed++;
  }

  return { puzzle, solution };
}

function getConflicts(grid: Grid, row: number, col: number, val: number): Set<string> {
  const conflicts = new Set<string>();
  for (let c = 0; c < 9; c++) {
    if (c !== col && grid[row][c] === val) conflicts.add(`${row},${c}`);
  }
  for (let r = 0; r < 9; r++) {
    if (r !== row && grid[r][col] === val) conflicts.add(`${r},${col}`);
  }
  const br = Math.floor(row / 3) * 3;
  const bc = Math.floor(col / 3) * 3;
  for (let r = br; r < br + 3; r++) {
    for (let c = bc; c < bc + 3; c++) {
      if ((r !== row || c !== col) && grid[r][c] === val) conflicts.add(`${r},${c}`);
    }
  }
  return conflicts;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function SudokuGame({ onAddHighscore }: SudokuGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [difficulty, setDifficulty] = useState<Difficulty | null>(null);
  const [_puzzle, setPuzzle] = useState<Grid | null>(null);
  const [solution, setSolution] = useState<Grid | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [fixed, setFixed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<[number, number] | null>(null);
  const [timer, setTimer] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const [containerWidth, setContainerWidth] = useState(300);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const startGame = useCallback((diff: Difficulty) => {
    setDifficulty(diff);
    const { puzzle: p, solution: s } = generatePuzzle(DIFFICULTY_CLUES[diff]);
    setPuzzle(p);
    setSolution(s);
    setGrid(p.map((row) => [...row]));
    const fixedSet = new Set<string>();
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (p[r][c] !== null) fixedSet.add(`${r},${c}`);
      }
    }
    setFixed(fixedSet);
    setSelected(null);
    setTimer(0);
    setIsComplete(false);
  }, []);

  // Timer
  useEffect(() => {
    if (grid && !isComplete) {
      timerRef.current = setInterval(() => setTimer((t) => t + 1), 1000);
      return () => clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [grid, isComplete]);

  // Check completion
  const checkComplete = useCallback((g: Grid) => {
    if (!solution) return false;
    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        if (g[r][c] !== solution[r][c]) return false;
      }
    }
    return true;
  }, [solution]);

  const handleCellClick = useCallback((r: number, c: number) => {
    if (isComplete) return;
    if (fixed.has(`${r},${c}`)) {
      setSelected([r, c]);
      return;
    }
    setSelected([r, c]);
  }, [fixed, isComplete]);

  const handleNumber = useCallback((num: number | null) => {
    if (!grid || !selected || isComplete) return;
    const [r, c] = selected;
    if (fixed.has(`${r},${c}`)) return;

    const newGrid = grid.map((row) => [...row]);
    newGrid[r][c] = num;
    setGrid(newGrid);

    if (num !== null && checkComplete(newGrid)) {
      setIsComplete(true);
      clearInterval(timerRef.current);
      const mult = DIFFICULTY_MULT[difficulty!];
      const score = Math.round((mult * 10000) / Math.max(timer, 1));
      onAddHighscore(score);
    }
  }, [grid, selected, fixed, isComplete, checkComplete, difficulty, timer, onAddHighscore]);

  // Key handler
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (!grid || !selected || isComplete) return;

      if (e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        handleNumber(parseInt(e.key));
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        handleNumber(null);
      } else if (e.key === "ArrowUp" && selected[0] > 0) {
        e.preventDefault();
        setSelected([selected[0] - 1, selected[1]]);
      } else if (e.key === "ArrowDown" && selected[0] < 8) {
        e.preventDefault();
        setSelected([selected[0] + 1, selected[1]]);
      } else if (e.key === "ArrowLeft" && selected[1] > 0) {
        e.preventDefault();
        setSelected([selected[0], selected[1] - 1]);
      } else if (e.key === "ArrowRight" && selected[1] < 8) {
        e.preventDefault();
        setSelected([selected[0], selected[1] + 1]);
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [grid, selected, isComplete, handleNumber]);

  // Auto-focus
  useEffect(() => { containerRef.current?.focus(); }, [grid, isComplete]);

  // Compute all conflicts for current grid state
  const conflictCells = new Set<string>();
  if (grid && selected) {
    const [sr, sc] = selected;
    const val = grid[sr][sc];
    if (val !== null) {
      const c = getConflicts(grid, sr, sc, val);
      c.forEach((k) => conflictCells.add(k));
      if (c.size > 0) conflictCells.add(`${sr},${sc}`);
    }
  }

  const cellSize = Math.max(24, Math.min(42, Math.floor((containerWidth - 40) / 9)));
  const gridPx = cellSize * 9 + 8; // account for thick borders

  // Difficulty selector
  if (!grid) {
    return (
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          backgroundColor: "var(--ezy-bg)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ezy-text)", marginBottom: 8 }}>
          Select Difficulty
        </div>
        {(["easy", "medium", "hard"] as Difficulty[]).map((d) => (
          <button
            key={d}
            onClick={() => startGame(d)}
            style={{
              padding: "8px 32px",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ezy-text)",
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 6,
              cursor: "pointer",
              textTransform: "capitalize",
              width: 160,
              transition: "border-color 120ms ease",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ezy-accent)")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ezy-border)")}
          >
            {d} ({DIFFICULTY_CLUES[d]} clues)
          </button>
        ))}
      </div>
    );
  }

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
      {/* Info bar */}
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
        <span style={{ textTransform: "capitalize" }}>{difficulty}</span>
        <span>{formatTime(timer)}</span>
        <button
          onClick={() => { setPuzzle(null); setSolution(null); setGrid(null); setDifficulty(null); }}
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

      {/* Grid */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", position: "relative", gap: 12, padding: 8 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(9, ${cellSize}px)`,
            gridTemplateRows: `repeat(9, ${cellSize}px)`,
            width: gridPx,
            border: "2px solid var(--ezy-text-muted)",
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          {grid.map((row, r) =>
            row.map((val, c) => {
              const isFixed = fixed.has(`${r},${c}`);
              const isSelected = selected && selected[0] === r && selected[1] === c;
              const isConflict = conflictCells.has(`${r},${c}`);
              const sameValue = selected && grid[selected[0]][selected[1]] !== null && val === grid[selected[0]][selected[1]];
              const inSameBox = selected && Math.floor(r / 3) === Math.floor(selected[0] / 3) && Math.floor(c / 3) === Math.floor(selected[1] / 3);
              const inSameRowCol = selected && (r === selected[0] || c === selected[1]);

              const borderRight = (c + 1) % 3 === 0 && c < 8 ? "2px solid var(--ezy-text-muted)" : "1px solid var(--ezy-border)";
              const borderBottom = (r + 1) % 3 === 0 && r < 8 ? "2px solid var(--ezy-text-muted)" : "1px solid var(--ezy-border)";

              let bg = "var(--ezy-bg)";
              if (isSelected) bg = "var(--ezy-surface-raised)";
              else if (sameValue && val !== null) bg = "var(--ezy-surface)";
              else if (inSameBox || inSameRowCol) bg = "var(--ezy-surface)";

              return (
                <div
                  key={`${r}-${c}`}
                  onClick={() => handleCellClick(r, c)}
                  style={{
                    width: cellSize,
                    height: cellSize,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: cellSize < 30 ? 12 : 16,
                    fontWeight: isFixed ? 600 : 400,
                    color: isConflict
                      ? "#f87171"
                      : isFixed
                        ? "var(--ezy-text-secondary)"
                        : "var(--ezy-text)",
                    backgroundColor: bg,
                    borderRight,
                    borderBottom,
                    cursor: "pointer",
                    boxSizing: "border-box",
                    outline: isSelected ? "2px solid var(--ezy-accent)" : "none",
                    outlineOffset: -2,
                    fontVariantNumeric: "tabular-nums",
                    transition: "background-color 80ms ease",
                  }}
                >
                  {val || ""}
                </div>
              );
            })
          )}
        </div>

        {/* Number buttons */}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "center" }}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
            <button
              key={n}
              onClick={() => handleNumber(n)}
              style={{
                width: Math.max(28, cellSize - 4),
                height: Math.max(28, cellSize - 4),
                fontSize: 14,
                fontWeight: 600,
                color: "var(--ezy-text)",
                backgroundColor: "var(--ezy-surface)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 4,
                cursor: "pointer",
                transition: "border-color 120ms ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ezy-accent)")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ezy-border)")}
            >
              {n}
            </button>
          ))}
          <button
            onClick={() => handleNumber(null)}
            style={{
              width: Math.max(28, cellSize - 4),
              height: Math.max(28, cellSize - 4),
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ezy-text-muted)",
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            CLR
          </button>
        </div>

        {/* Completion overlay */}
        {isComplete && (
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
            <div style={{ fontSize: 18, fontWeight: 700, color: "#4ade80" }}>Completed!</div>
            <div style={{ fontSize: 13, color: "var(--ezy-text-secondary)" }}>
              Time: {formatTime(timer)}
            </div>
            <div style={{ fontSize: 14, color: "var(--ezy-accent)", fontWeight: 600 }}>
              Score: {Math.round((DIFFICULTY_MULT[difficulty!] * 10000) / Math.max(timer, 1))}
            </div>
            <button
              onClick={() => { setPuzzle(null); setSolution(null); setGrid(null); setDifficulty(null); }}
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
              New Game
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

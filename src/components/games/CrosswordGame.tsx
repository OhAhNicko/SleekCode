import { useState, useEffect, useCallback, useRef } from "react";
import type { CrosswordPuzzle, CrosswordClue } from "../../types";
import { generateCrossword } from "../../lib/generate-crossword";

interface CrosswordGameProps {
  puzzle: CrosswordPuzzle;
  onComplete: (id: string) => void;
  allCompleted: boolean;
  onGenerateNew: (puzzle: CrosswordPuzzle) => void;
  paused?: boolean;
}

type Direction = "across" | "down";

export default function CrosswordGame({ puzzle, onComplete, allCompleted, onGenerateNew, paused = false }: CrosswordGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [userGrid, setUserGrid] = useState<string[][]>(() =>
    puzzle.grid.map((row) => row.map((cell) => (cell === "#" ? "#" : "")))
  );
  const [selectedCell, setSelectedCell] = useState<[number, number] | null>(null);
  const [direction, setDirection] = useState<Direction>("across");
  const [completed, setCompleted] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState(300);

  useEffect(() => {
    setUserGrid(puzzle.grid.map((row) => row.map((cell) => (cell === "#" ? "#" : ""))));
    setSelectedCell(null);
    setCompleted(false);
  }, [puzzle.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = puzzle.grid.length;
  const cols = puzzle.grid[0]?.length ?? 0;

  const numberMap = new Map<string, number>();
  const allClues = [...puzzle.clues.across, ...puzzle.clues.down];
  for (const clue of allClues) {
    const key = `${clue.row},${clue.col}`;
    if (!numberMap.has(key)) numberMap.set(key, clue.number);
  }

  const getWordCells = useCallback(
    (row: number, col: number, dir: Direction): [number, number][] => {
      const cells: [number, number][] = [];
      if (dir === "across") {
        let c = col;
        while (c > 0 && puzzle.grid[row][c - 1] !== "#") c--;
        while (c < cols && puzzle.grid[row][c] !== "#") { cells.push([row, c]); c++; }
      } else {
        let r = row;
        while (r > 0 && puzzle.grid[r - 1][col] !== "#") r--;
        while (r < rows && puzzle.grid[r][col] !== "#") { cells.push([r, col]); r++; }
      }
      return cells;
    },
    [puzzle.grid, rows, cols]
  );

  const activeWordCells = selectedCell
    ? new Set(getWordCells(selectedCell[0], selectedCell[1], direction).map(([r, c]) => `${r},${c}`))
    : new Set<string>();

  const getActiveClue = useCallback((): CrosswordClue | null => {
    if (!selectedCell) return null;
    const wordCells = getWordCells(selectedCell[0], selectedCell[1], direction);
    if (wordCells.length === 0) return null;
    const [startR, startC] = wordCells[0];
    const clueList = direction === "across" ? puzzle.clues.across : puzzle.clues.down;
    return clueList.find((cl) => cl.row === startR && cl.col === startC) ?? null;
  }, [selectedCell, direction, getWordCells, puzzle.clues]);

  const handleCellClick = useCallback(
    (r: number, c: number) => {
      if (puzzle.grid[r][c] === "#" || completed) return;
      if (selectedCell && selectedCell[0] === r && selectedCell[1] === c) {
        setDirection((d) => (d === "across" ? "down" : "across"));
      } else {
        setSelectedCell([r, c]);
      }
    },
    [selectedCell, puzzle.grid, completed]
  );

  const checkCompletion = useCallback(
    (grid: string[][]) => {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (puzzle.grid[r][c] !== "#" && grid[r][c].toUpperCase() !== puzzle.grid[r][c].toUpperCase()) return false;
        }
      }
      return true;
    },
    [puzzle.grid, rows, cols]
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handler = (e: KeyboardEvent) => {
      if (completed || paused || !selectedCell) return;
      const [r, c] = selectedCell;

      if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
        e.preventDefault();
        const newGrid = userGrid.map((row) => [...row]);
        newGrid[r][c] = e.key.toUpperCase();
        setUserGrid(newGrid);

        const wordCells = getWordCells(r, c, direction);
        const idx = wordCells.findIndex(([wr, wc]) => wr === r && wc === c);
        if (idx >= 0 && idx < wordCells.length - 1) setSelectedCell(wordCells[idx + 1]);

        if (checkCompletion(newGrid)) {
          setCompleted(true);
          onComplete(puzzle.id);
        }
      } else if (e.key === "Backspace") {
        e.preventDefault();
        const newGrid = userGrid.map((row) => [...row]);
        if (newGrid[r][c] !== "") {
          newGrid[r][c] = "";
        } else {
          const wordCells = getWordCells(r, c, direction);
          const idx = wordCells.findIndex(([wr, wc]) => wr === r && wc === c);
          if (idx > 0) {
            const [pr, pc] = wordCells[idx - 1];
            newGrid[pr][pc] = "";
            setSelectedCell([pr, pc]);
          }
        }
        setUserGrid(newGrid);
      } else if (e.key === "Tab") {
        e.preventDefault();
        setDirection((d) => (d === "across" ? "down" : "across"));
      } else if (e.key === "ArrowUp" && r > 0) {
        e.preventDefault();
        for (let nr = r - 1; nr >= 0; nr--) {
          if (puzzle.grid[nr][c] !== "#") { setSelectedCell([nr, c]); setDirection("down"); break; }
        }
      } else if (e.key === "ArrowDown" && r < rows - 1) {
        e.preventDefault();
        for (let nr = r + 1; nr < rows; nr++) {
          if (puzzle.grid[nr][c] !== "#") { setSelectedCell([nr, c]); setDirection("down"); break; }
        }
      } else if (e.key === "ArrowLeft" && c > 0) {
        e.preventDefault();
        for (let nc = c - 1; nc >= 0; nc--) {
          if (puzzle.grid[r][nc] !== "#") { setSelectedCell([r, nc]); setDirection("across"); break; }
        }
      } else if (e.key === "ArrowRight" && c < cols - 1) {
        e.preventDefault();
        for (let nc = c + 1; nc < cols; nc++) {
          if (puzzle.grid[r][nc] !== "#") { setSelectedCell([r, nc]); setDirection("across"); break; }
        }
      }
    };

    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [selectedCell, direction, userGrid, completed, puzzle, rows, cols, getWordCells, checkCompletion, onComplete]);

  useEffect(() => { containerRef.current?.focus(); }, [selectedCell]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setGenerateError(null);
    try {
      const newPuzzle = await generateCrossword();
      onGenerateNew(newPuzzle);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }, [onGenerateNew]);

  // Grid fills the available width — subtract padding + border
  const cellSize = Math.max(28, Math.min(52, Math.floor((containerWidth - 24) / cols)));
  const activeClue = getActiveClue();

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
        overflow: "auto",
      }}
    >
      {/* Active clue bar — single line */}
      <div
        style={{
          padding: "6px 12px",
          fontSize: 12,
          color: activeClue ? "var(--ezy-text)" : "var(--ezy-text-muted)",
          borderBottom: "1px solid var(--ezy-border)",
          backgroundColor: "var(--ezy-surface)",
          minHeight: 28,
          display: "flex",
          alignItems: "center",
          fontStyle: activeClue ? "normal" : "italic",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {activeClue ? (
          <>
            <span style={{ fontWeight: 600, color: "var(--ezy-accent)", marginRight: 6, flexShrink: 0 }}>
              {activeClue.number}{direction === "across" ? "A" : "D"}
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{activeClue.clue}</span>
          </>
        ) : (
          "Click a cell to begin"
        )}
      </div>

      {/* Grid + Clues */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "12px 10px", gap: 10 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${cols}, ${cellSize}px)`,
            gridTemplateRows: `repeat(${rows}, ${cellSize}px)`,
            border: "2px solid var(--ezy-text-muted)",
            borderRadius: 3,
          }}
        >
          {puzzle.grid.map((row, r) =>
            row.map((cell, c) => {
              if (cell === "#") {
                return (
                  <div
                    key={`${r}-${c}`}
                    style={{
                      width: cellSize,
                      height: cellSize,
                      backgroundColor: "var(--ezy-surface)",
                      borderRight: "1px solid var(--ezy-border)",
                      borderBottom: "1px solid var(--ezy-border)",
                    }}
                  />
                );
              }

              const isSelected = selectedCell && selectedCell[0] === r && selectedCell[1] === c;
              const isInWord = activeWordCells.has(`${r},${c}`);
              const numLabel = numberMap.get(`${r},${c}`);
              const userVal = userGrid[r]?.[c] ?? "";
              const isCorrect = userVal.toUpperCase() === cell.toUpperCase();

              return (
                <div
                  key={`${r}-${c}`}
                  onClick={() => handleCellClick(r, c)}
                  style={{
                    width: cellSize,
                    height: cellSize,
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: isSelected
                      ? "var(--ezy-surface-raised)"
                      : isInWord
                        ? "var(--ezy-surface)"
                        : "var(--ezy-bg)",
                    borderRight: "1px solid var(--ezy-border)",
                    borderBottom: "1px solid var(--ezy-border)",
                    cursor: "pointer",
                    outline: isSelected ? "2px solid var(--ezy-accent)" : "none",
                    outlineOffset: -2,
                    boxSizing: "border-box",
                  }}
                >
                  {numLabel && (
                    <span
                      style={{
                        position: "absolute",
                        top: 1,
                        left: 2,
                        fontSize: cellSize < 34 ? 8 : 10,
                        fontWeight: 600,
                        color: "var(--ezy-text-muted)",
                        lineHeight: 1,
                      }}
                    >
                      {numLabel}
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: cellSize < 34 ? 14 : 18,
                      fontWeight: 600,
                      color: completed && isCorrect ? "#4ade80" : "var(--ezy-text)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {userVal}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* Clues — across and down side by side, single-line per clue */}
        <div
          style={{
            display: "flex",
            gap: 12,
            fontSize: 11,
            color: "var(--ezy-text-secondary)",
            width: "100%",
            maxWidth: cols * cellSize + 4,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: "var(--ezy-text)", marginBottom: 3, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Across</div>
            {puzzle.clues.across.map((cl) => (
              <div
                key={`a-${cl.number}`}
                onClick={() => { setSelectedCell([cl.row, cl.col]); setDirection("across"); }}
                style={{
                  padding: "1px 0",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: activeClue?.number === cl.number && direction === "across"
                    ? "var(--ezy-accent)"
                    : "var(--ezy-text-secondary)",
                  lineHeight: 1.5,
                }}
                title={`${cl.number}. ${cl.clue}`}
              >
                <strong>{cl.number}.</strong> {cl.clue}
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: "var(--ezy-text)", marginBottom: 3, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Down</div>
            {puzzle.clues.down.map((cl) => (
              <div
                key={`d-${cl.number}`}
                onClick={() => { setSelectedCell([cl.row, cl.col]); setDirection("down"); }}
                style={{
                  padding: "1px 0",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  color: activeClue?.number === cl.number && direction === "down"
                    ? "var(--ezy-accent)"
                    : "var(--ezy-text-secondary)",
                  lineHeight: 1.5,
                }}
                title={`${cl.number}. ${cl.clue}`}
              >
                <strong>{cl.number}.</strong> {cl.clue}
              </div>
            ))}
          </div>
        </div>

        {allCompleted && !generating && (
          <button
            onClick={handleGenerate}
            style={{
              padding: "8px 20px",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--ezy-text)",
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 6,
              cursor: "pointer",
              transition: "border-color 120ms ease",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--ezy-accent)")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--ezy-border)")}
          >
            Generate New Puzzle (AI)
          </button>
        )}
        {generating && (
          <div style={{ fontSize: 12, color: "var(--ezy-text-muted)" }}>Generating puzzle...</div>
        )}
        {generateError && (
          <div style={{ fontSize: 12, color: "#f87171" }}>{generateError}</div>
        )}
      </div>

      {/* Completion overlay */}
      {completed && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.6)",
            zIndex: 100,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              padding: "20px 40px",
              backgroundColor: "var(--ezy-surface)",
              borderRadius: 8,
              border: "1px solid var(--ezy-accent)",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, color: "#4ade80" }}>Completed!</div>
            <div style={{ fontSize: 12, color: "var(--ezy-text-secondary)", marginTop: 6 }}>Puzzle solved</div>
          </div>
        </div>
      )}
    </div>
  );
}

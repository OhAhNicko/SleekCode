import { useState, useEffect, useCallback, useRef, useMemo } from "react";

interface Game2048Props {
  onAddHighscore: (score: number) => void;
  paused?: boolean;
}

type Board = (number | null)[][];

// ─── Dynamic theme-derived tile palette ─────────────────────────────

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(color * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

interface TileStyle { bg: string; fg: string; glow?: string }

// Tile values in order: 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192
// Progression: dark neutral → accent-tinted → full accent → beyond
function buildTilePalette(accentHex: string, bgHex: string): Record<number, TileStyle> {
  const [ah, as, al] = hexToHsl(accentHex);
  const [, , bgL] = hexToHsl(bgHex);

  // Base lightness from bg (typically 4-18 for dark themes)
  const baseL = Math.max(bgL + 4, 10);

  // 13 steps with hand-tuned saturation and lightness ramps
  const steps: { val: number; sat: number; lit: number; fgLit: number; glowAlpha?: number }[] = [
    { val: 2,    sat: 5,   lit: baseL + 2,  fgLit: 54 },
    { val: 4,    sat: 8,   lit: baseL + 5,  fgLit: 62 },
    { val: 8,    sat: 20,  lit: baseL + 7,  fgLit: 70 },
    { val: 16,   sat: 30,  lit: baseL + 10, fgLit: 74 },
    { val: 32,   sat: 40,  lit: baseL + 13, fgLit: 78 },
    { val: 64,   sat: 50,  lit: baseL + 16, fgLit: 82, glowAlpha: 0.12 },
    { val: 128,  sat: 58,  lit: baseL + 20, fgLit: 86, glowAlpha: 0.18 },
    { val: 256,  sat: 65,  lit: baseL + 25, fgLit: 90, glowAlpha: 0.22 },
    { val: 512,  sat: 72,  lit: baseL + 30, fgLit: 94, glowAlpha: 0.28 },
    { val: 1024, sat: 80,  lit: baseL + 36, fgLit: 97, glowAlpha: 0.34 },
    { val: 2048, sat: as,   lit: al,         fgLit: al > 55 ? 8 : 97, glowAlpha: 0.5 },
    { val: 4096, sat: Math.min(as + 10, 100), lit: Math.min(al + 8, 70), fgLit: al > 50 ? 8 : 97, glowAlpha: 0.4 },
    { val: 8192, sat: Math.min(as + 15, 100), lit: Math.min(al + 14, 75), fgLit: al > 45 ? 8 : 97, glowAlpha: 0.45 },
  ];

  const palette: Record<number, TileStyle> = {};
  for (const step of steps) {
    const bg = hslToHex(ah, step.sat, step.lit);
    const fg = hslToHex(ah, Math.min(step.sat, 15), step.fgLit);
    const glow = step.glowAlpha
      ? `rgba(${parseInt(accentHex.slice(1, 3), 16)},${parseInt(accentHex.slice(3, 5), 16)},${parseInt(accentHex.slice(5, 7), 16)},${step.glowAlpha})`
      : undefined;
    palette[step.val] = { bg, fg, glow };
  }
  return palette;
}

function readCssVar(name: string, fallback: string): string {
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

function createEmptyBoard(): Board {
  return Array.from({ length: 4 }, () => Array(4).fill(null));
}

// Returns board + position of new tile for animation
function addRandomTile(board: Board): { board: Board; newTile: [number, number] | null } {
  const empty: [number, number][] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (board[r][c] === null) empty.push([r, c]);
    }
  }
  if (empty.length === 0) return { board, newTile: null };
  const [r, c] = empty[Math.floor(Math.random() * empty.length)];
  const newBoard = board.map((row) => [...row]);
  newBoard[r][c] = Math.random() < 0.9 ? 2 : 4;
  return { board: newBoard, newTile: [r, c] };
}

function slideRow(row: (number | null)[]): { result: (number | null)[]; score: number; mergedAt: number[] } {
  const nums = row.filter((v): v is number => v !== null);
  const merged: number[] = [];
  const mergedAt: number[] = [];
  let score = 0;
  let i = 0;
  while (i < nums.length) {
    if (i + 1 < nums.length && nums[i] === nums[i + 1]) {
      const val = nums[i] * 2;
      merged.push(val);
      mergedAt.push(merged.length - 1);
      score += val;
      i += 2;
    } else {
      merged.push(nums[i]);
      i++;
    }
  }
  while (merged.length < 4) merged.push(null as unknown as number);
  return { result: merged.map((v) => (v === 0 ? null : v)) as (number | null)[], score, mergedAt };
}

function move(board: Board, direction: "up" | "down" | "left" | "right"): { board: Board; score: number; moved: boolean; mergedCells: Set<string> } {
  let totalScore = 0;
  const newBoard = createEmptyBoard();
  let moved = false;
  const mergedCells = new Set<string>();

  for (let i = 0; i < 4; i++) {
    let line: (number | null)[];
    switch (direction) {
      case "left": line = board[i].slice(); break;
      case "right": line = board[i].slice().reverse(); break;
      case "up": line = [board[0][i], board[1][i], board[2][i], board[3][i]]; break;
      case "down": line = [board[3][i], board[2][i], board[1][i], board[0][i]]; break;
    }

    const { result, score, mergedAt } = slideRow(line);
    totalScore += score;

    let output = result;
    let adjustedMerged = mergedAt;
    if (direction === "right" || direction === "down") {
      output = result.slice().reverse();
      adjustedMerged = mergedAt.map((idx) => 3 - idx);
    }

    for (let j = 0; j < 4; j++) {
      switch (direction) {
        case "left": case "right":
          newBoard[i][j] = output[j];
          if (output[j] !== board[i][j]) moved = true;
          if (adjustedMerged.includes(j)) mergedCells.add(`${i},${j}`);
          break;
        case "up": case "down":
          newBoard[j][i] = output[j];
          if (output[j] !== board[j][i]) moved = true;
          if (adjustedMerged.includes(j)) mergedCells.add(`${j},${i}`);
          break;
      }
    }
  }

  return { board: newBoard, score: totalScore, moved, mergedCells };
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

export default function Game2048({ onAddHighscore, paused = false }: Game2048Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState<Board>(() => {
    let b = createEmptyBoard();
    b = addRandomTile(b).board;
    b = addRandomTile(b).board;
    return b;
  });
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [containerWidth, setContainerWidth] = useState(300);
  // Animation state: cells that should pop
  const [popCells, setPopCells] = useState<Set<string>>(new Set());
  const [spawnCell, setSpawnCell] = useState<string | null>(null);

  // Theme-derived tile palette — rebuilds when accent changes
  const [accentHex, setAccentHex] = useState(() => readCssVar("--ezy-accent", "#5eead4"));
  const [bgHex, setBgHex] = useState(() => readCssVar("--ezy-bg", "#0d0d0d"));

  useEffect(() => {
    // Poll for theme changes (CSS var mutations aren't observable)
    const check = () => {
      const a = readCssVar("--ezy-accent", "#5eead4");
      const b = readCssVar("--ezy-bg", "#0d0d0d");
      if (a !== accentHex) setAccentHex(a);
      if (b !== bgHex) setBgHex(b);
    };
    check();
    const id = setInterval(check, 1000);
    return () => clearInterval(id);
  }, [accentHex, bgHex]);

  const tilePalette = useMemo(() => buildTilePalette(accentHex, bgHex), [accentHex, bgHex]);

  const getTileStyle = useCallback((val: number): TileStyle => {
    return tilePalette[val] || { bg: "#a3a3a3", fg: "#000000" };
  }, [tilePalette]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const resetGame = useCallback(() => {
    let b = createEmptyBoard();
    b = addRandomTile(b).board;
    b = addRandomTile(b).board;
    setBoard(b);
    setScore(0);
    setGameOver(false);
    setPopCells(new Set());
    setSpawnCell(null);
  }, []);

  const handleMove = useCallback(
    (direction: "up" | "down" | "left" | "right") => {
      if (gameOver || paused) return;
      const { board: newBoard, score: gained, moved, mergedCells } = move(board, direction);
      if (!moved) return;

      const { board: withNew, newTile } = addRandomTile(newBoard);
      const newScore = score + gained;
      setBoard(withNew);
      setScore(newScore);
      setPopCells(mergedCells);
      setSpawnCell(newTile ? `${newTile[0]},${newTile[1]}` : null);

      // Clear animation after it plays
      setTimeout(() => { setPopCells(new Set()); setSpawnCell(null); }, 180);

      if (!canMove(withNew)) {
        setGameOver(true);
        if (newScore > 0) onAddHighscore(newScore);
        setBestScore((prev) => Math.max(prev, newScore));
      }
    },
    [board, score, gameOver, paused, onAddHighscore]
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp": case "w": case "W": e.preventDefault(); handleMove("up"); break;
        case "ArrowDown": case "s": case "S": e.preventDefault(); handleMove("down"); break;
        case "ArrowLeft": case "a": case "A": e.preventDefault(); handleMove("left"); break;
        case "ArrowRight": case "d": case "D": e.preventDefault(); handleMove("right"); break;
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [handleMove]);

  useEffect(() => { containerRef.current?.focus(); }, [gameOver]);

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
      <style>{`
        @keyframes tile-pop {
          0% { transform: scale(1); }
          50% { transform: scale(1.15); }
          100% { transform: scale(1); }
        }
        @keyframes tile-spawn {
          0% { transform: scale(0); opacity: 0; }
          60% { transform: scale(1.08); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>

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
              const key = `${r},${c}`;
              const style = val ? getTileStyle(val) : { bg: "var(--ezy-bg)", fg: "transparent" };
              const isMerged = popCells.has(key);
              const isSpawn = spawnCell === key;

              return (
                <div
                  key={key}
                  style={{
                    width: tileSize,
                    height: tileSize,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: style.bg,
                    color: style.fg,
                    fontSize: val && val >= 1024 ? tileFontSize - 2 : tileFontSize,
                    fontWeight: 700,
                    borderRadius: 4,
                    fontVariantNumeric: "tabular-nums",
                    boxShadow: val && style.glow ? `0 0 12px ${style.glow}` : "none",
                    animation: isMerged
                      ? "tile-pop 160ms ease-out"
                      : isSpawn
                        ? "tile-spawn 180ms ease-out"
                        : "none",
                    transition: "background-color 120ms ease",
                  }}
                >
                  {val || ""}
                </div>
              );
            })
          )}
        </div>

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

        {paused && !gameOver && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(0,0,0,0.6)",
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ezy-text-muted)" }}>Paused</div>
          </div>
        )}
      </div>
    </div>
  );
}

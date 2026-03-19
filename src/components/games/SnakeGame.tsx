import { useRef, useEffect, useState, useCallback } from "react";

interface SnakeGameProps {
  onAddHighscore: (score: number) => void;
  paused?: boolean;
}

type Direction = "up" | "down" | "left" | "right";
type Coord = [number, number];

const CELL_PX = 20;
const FOOD_SCORE = 10;
// Speed: starts at 95ms, floors at 55ms — ramps quickly
function getTick(score: number): number {
  return Math.max(55, 95 - Math.floor(score / FOOD_SCORE) * 3);
}

function getComputedColor(varName: string, fallback: string): string {
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return val || fallback;
}

export default function SnakeGame({ onAddHighscore, paused = false }: SnakeGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gridSize, setGridSize] = useState<{ cols: number; rows: number }>({ cols: 20, rows: 20 });
  const [gameState, setGameState] = useState<"idle" | "playing" | "over">("idle");
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [wallDeath, setWallDeath] = useState(false);

  const snakeRef = useRef<Coord[]>([[5, 5], [4, 5], [3, 5]]);
  const dirRef = useRef<Direction>("right");
  const nextDirRef = useRef<Direction>("right");
  const foodRef = useRef<Coord>([10, 10]);
  const scoreRef = useRef(0);
  const gameStateRef = useRef<"idle" | "playing" | "over">("idle");
  const tickTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const boostRef = useRef(false);
  const lastBoostTickRef = useRef(0);
  const stepRef = useRef<() => boolean>(() => false);

  const spawnFood = useCallback((snake: Coord[], cols: number, rows: number): Coord => {
    const occupied = new Set(snake.map(([x, y]) => `${x},${y}`));
    let fx: number, fy: number;
    let attempts = 0;
    do {
      fx = Math.floor(Math.random() * cols);
      fy = Math.floor(Math.random() * rows);
      attempts++;
    } while (occupied.has(`${fx},${fy}`) && attempts < 1000);
    return [fx, fy];
  }, []);

  // Resize observer — canvas area only
  useEffect(() => {
    const container = containerRef.current?.querySelector("[data-canvas-area]") as HTMLElement | null;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const cols = Math.max(10, Math.floor(width / CELL_PX));
        const rows = Math.max(10, Math.floor(height / CELL_PX));
        setGridSize({ cols, rows });
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Canvas rendering
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { cols, rows } = gridSize;
    canvas.width = cols * CELL_PX;
    canvas.height = rows * CELL_PX;

    const bgColor = getComputedColor("--ezy-bg", "#0d0d0d");
    const borderColor = getComputedColor("--ezy-border", "#2a2a2a");
    const accentColor = getComputedColor("--ezy-accent", "#5eead4");

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Subtle grid lines
    ctx.strokeStyle = borderColor;
    ctx.globalAlpha = 0.15;
    ctx.lineWidth = 1;
    for (let x = 0; x <= cols; x++) {
      ctx.beginPath();
      ctx.moveTo(x * CELL_PX + 0.5, 0);
      ctx.lineTo(x * CELL_PX + 0.5, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * CELL_PX + 0.5);
      ctx.lineTo(canvas.width, y * CELL_PX + 0.5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Food — glowing circle
    const [fx, fy] = foodRef.current;
    ctx.fillStyle = "#f87171";
    ctx.shadowColor = "#f87171";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(fx * CELL_PX + CELL_PX / 2, fy * CELL_PX + CELL_PX / 2, CELL_PX / 2 - 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Snake
    const snake = snakeRef.current;
    for (let i = 0; i < snake.length; i++) {
      const [sx, sy] = snake[i];
      const isHead = i === 0;
      const t = i / Math.max(snake.length - 1, 1);
      ctx.globalAlpha = 1 - t * 0.55;
      ctx.fillStyle = accentColor;
      if (isHead) {
        ctx.shadowColor = accentColor;
        ctx.shadowBlur = boostRef.current ? 12 : 5;
      }
      const pad = isHead ? 0.5 : 1;
      const radius = isHead ? 2.5 : 1.5;
      const x = sx * CELL_PX + pad;
      const y = sy * CELL_PX + pad;
      const w = CELL_PX - pad * 2;
      const h = CELL_PX - pad * 2;
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.arcTo(x + w, y, x + w, y + h, radius);
      ctx.arcTo(x + w, y + h, x, y + h, radius);
      ctx.arcTo(x, y + h, x, y, radius);
      ctx.arcTo(x, y, x + w, y, radius);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }, [gridSize]);

  const startGame = useCallback(() => {
    const { cols, rows } = gridSize;
    const startX = Math.floor(cols / 4);
    const startY = Math.floor(rows / 2);
    snakeRef.current = [[startX, startY], [startX - 1, startY], [startX - 2, startY]];
    dirRef.current = "right";
    nextDirRef.current = "right";
    boostRef.current = false;
    foodRef.current = spawnFood(snakeRef.current, cols, rows);
    scoreRef.current = 0;
    setScore(0);
    setGameState("playing");
    gameStateRef.current = "playing";
  }, [gridSize, spawnFood]);

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Stable refs for values used inside the game loop — avoids effect re-runs
  const gridSizeRef = useRef(gridSize);
  gridSizeRef.current = gridSize;
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const spawnFoodRef = useRef(spawnFood);
  spawnFoodRef.current = spawnFood;
  const onAddHighscoreRef = useRef(onAddHighscore);
  onAddHighscoreRef.current = onAddHighscore;
  const wallDeathRef = useRef(wallDeath);
  wallDeathRef.current = wallDeath;

  // One step of snake movement — called by both the tick chain and keydown boost
  const step = useCallback((): boolean => {
    if (gameStateRef.current !== "playing" || pausedRef.current) return false;

    const { cols, rows } = gridSizeRef.current;
    const snake = snakeRef.current;
    dirRef.current = nextDirRef.current;
    const [hx, hy] = snake[0];

    let nx = hx, ny = hy;
    switch (dirRef.current) {
      case "up": ny--; break;
      case "down": ny++; break;
      case "left": nx--; break;
      case "right": nx++; break;
    }

    // Wall handling: wrap or die
    if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) {
      if (wallDeathRef.current) {
        gameStateRef.current = "over";
        setGameState("over");
        if (scoreRef.current > 0) onAddHighscoreRef.current(scoreRef.current);
        setBestScore((prev) => Math.max(prev, scoreRef.current));
        return false;
      }
      // Wrap around
      if (nx < 0) nx = cols - 1;
      else if (nx >= cols) nx = 0;
      if (ny < 0) ny = rows - 1;
      else if (ny >= rows) ny = 0;
    }

    for (let i = 0; i < snake.length - 1; i++) {
      if (snake[i][0] === nx && snake[i][1] === ny) {
        gameStateRef.current = "over";
        setGameState("over");
        if (scoreRef.current > 0) onAddHighscoreRef.current(scoreRef.current);
        setBestScore((prev) => Math.max(prev, scoreRef.current));
        return false;
      }
    }

    const newSnake: Coord[] = [[nx, ny], ...snake];
    const [fx, fy] = foodRef.current;
    if (nx === fx && ny === fy) {
      scoreRef.current += FOOD_SCORE;
      setScore(scoreRef.current);
      foodRef.current = spawnFoodRef.current(newSnake, cols, rows);
    } else {
      newSnake.pop();
    }
    snakeRef.current = newSnake;
    drawRef.current();
    return true;
  }, []);
  stepRef.current = step;

  // Game loop — setTimeout chain that calls step()
  useEffect(() => {
    if (gameState !== "playing" || paused) {
      boostRef.current = false;
      return;
    }

    function tick() {
      if (!step()) return;
      const baseMs = getTick(scoreRef.current);
      tickTimerRef.current = setTimeout(tick, boostRef.current ? Math.round(baseMs * 0.5) : baseMs);
    }

    tickTimerRef.current = setTimeout(tick, getTick(scoreRef.current));
    return () => clearTimeout(tickTimerRef.current);
  }, [gameState, paused, step]);

  // Key handler
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const opposite: Record<Direction, Direction> = { up: "down", down: "up", left: "right", right: "left" };

    const keyToDir = (key: string): Direction | null => {
      switch (key) {
        case "ArrowUp": case "w": case "W": return "up";
        case "ArrowDown": case "s": case "S": return "down";
        case "ArrowLeft": case "a": case "A": return "left";
        case "ArrowRight": case "d": case "D": return "right";
        default: return null;
      }
    };

    const handleKey = (e: KeyboardEvent) => {
      if (gameStateRef.current !== "playing") return;
      const pressedDir = keyToDir(e.key);
      if (!pressedDir) return;

      e.preventDefault();
      e.stopPropagation();

      // Block 180-degree reversal
      if (pressedDir === opposite[dirRef.current]) return;

      // Same direction as intended: boost — move snake immediately (rate-limited)
      if (pressedDir === nextDirRef.current) {
        boostRef.current = true;
        const now = performance.now();
        const minInterval = Math.round(getTick(scoreRef.current) * 0.5);
        if (now - lastBoostTickRef.current >= minInterval) {
          lastBoostTickRef.current = now;
          clearTimeout(tickTimerRef.current);
          if (stepRef.current()) {
            // Restart the tick chain at boosted speed
            const baseMs = getTick(scoreRef.current);
            tickTimerRef.current = setTimeout(function boostTick() {
              if (!stepRef.current()) return;
              const ms = getTick(scoreRef.current);
              tickTimerRef.current = setTimeout(boostTick, boostRef.current ? Math.round(ms * 0.5) : ms);
            }, Math.round(baseMs * 0.5));
          }
        }
      } else {
        nextDirRef.current = pressedDir;
        boostRef.current = false;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const releasedDir = keyToDir(e.key);
      if (releasedDir && releasedDir === nextDirRef.current) {
        boostRef.current = false;
      }
    };

    const handleBlur = () => { boostRef.current = false; };

    container.addEventListener("keydown", handleKey);
    container.addEventListener("keyup", handleKeyUp);
    container.addEventListener("blur", handleBlur);
    return () => {
      container.removeEventListener("keydown", handleKey);
      container.removeEventListener("keyup", handleKeyUp);
      container.removeEventListener("blur", handleBlur);
    };
  }, []);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => { containerRef.current?.focus(); }, [gameState]);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
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
        <span
          onClick={() => { if (gameState !== "playing") setWallDeath((v) => !v); }}
          style={{
            fontSize: 10,
            color: wallDeath ? "#f87171" : "var(--ezy-text-muted)",
            cursor: gameState === "playing" ? "default" : "pointer",
            userSelect: "none",
            opacity: gameState === "playing" ? 0.5 : 1,
            transition: "color 150ms ease",
          }}
          title={gameState === "playing" ? "Cannot change during game" : "Toggle wall death mode"}
        >
          {wallDeath ? "Walls: Kill" : "Walls: Wrap"}
        </span>
        {bestScore > 0 && <span>Best: {bestScore}</span>}
      </div>

      {/* Canvas area */}
      <div data-canvas-area style={{ flex: 1, position: "relative", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <canvas
          ref={canvasRef}
          style={{ display: "block" }}
        />

        {gameState !== "playing" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(0,0,0,0.75)",
              gap: 12,
            }}
          >
            {gameState === "over" && (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ezy-text)" }}>Game Over</div>
                <div style={{ fontSize: 14, color: "var(--ezy-accent)", fontWeight: 600 }}>Score: {score}</div>
                {score > 0 && score >= bestScore && (
                  <div style={{ fontSize: 12, color: "#4ade80", fontWeight: 600 }}>New Highscore!</div>
                )}
              </>
            )}
            {gameState === "idle" && (
              <div style={{ fontSize: 14, color: "var(--ezy-text-secondary)", marginBottom: 4 }}>
                Arrow keys or WASD to move &middot; hold to boost
              </div>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                startGame();
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
                transition: "opacity 150ms ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
            >
              {gameState === "over" ? "Play Again" : "Start Game"}
            </button>
          </div>
        )}

        {/* Pause overlay */}
        {paused && gameState === "playing" && (
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

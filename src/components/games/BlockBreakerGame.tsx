import { useRef, useEffect, useState, useCallback } from "react";

interface BlockBreakerGameProps {
  onAddHighscore: (score: number) => void;
  paused?: boolean;
}

interface Block {
  x: number;
  y: number;
  w: number;
  h: number;
  hits: number; // 0 = destroyed, 1 = normal, 2 = tough
  col: number;
  row: number;
}

interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

interface Paddle {
  x: number;
  y: number;
  w: number;
  h: number;
}

type GameState = "idle" | "playing" | "over" | "levelClear";

const INITIAL_BALL_SPEED = 4.5;
const PADDLE_HEIGHT = 12;
const BALL_RADIUS = 5;
const BLOCK_ROWS = 6;
const BLOCK_COLS = 10;
const BLOCK_PADDING = 3;
const MAX_LIVES = 3;
const MIN_VY = 1.5;

function getComputedColor(varName: string, fallback: string): string {
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return val || fallback;
}

function hexToRgba(hex: string, alpha: number): string {
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return `rgba(128,128,128,${alpha})`;
  return `rgba(${r},${g},${b},${alpha})`;
}

function lightenColor(hex: string, amount: number): string {
  const c = hex.replace("#", "");
  let r = parseInt(c.substring(0, 2), 16);
  let g = parseInt(c.substring(2, 4), 16);
  let b = parseInt(c.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return hex;
  r = Math.min(255, r + amount);
  g = Math.min(255, g + amount);
  b = Math.min(255, b + amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// Level pattern generators
function generateBlocks(
  level: number,
  canvasW: number,
  blockAreaH: number,
  blockAreaTop: number,
): Block[] {
  const cols = BLOCK_COLS;
  const rows = BLOCK_ROWS;
  const totalPadW = (cols + 1) * BLOCK_PADDING;
  const bw = (canvasW - totalPadW) / cols;
  const totalPadH = (rows + 1) * BLOCK_PADDING;
  const bh = (blockAreaH - totalPadH) / rows;

  const blocks: Block[] = [];
  const pattern = ((level - 1) % 6) + 1;

  const addBlock = (r: number, c: number, tough: boolean) => {
    blocks.push({
      col: c,
      row: r,
      x: BLOCK_PADDING + c * (bw + BLOCK_PADDING),
      y: blockAreaTop + BLOCK_PADDING + r * (bh + BLOCK_PADDING),
      w: bw,
      h: bh,
      hits: tough ? 2 : 1,
    });
  };

  switch (pattern) {
    case 1: // Rectangle (full grid)
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
          addBlock(r, c, r < 2);
      break;

    case 2: { // Pyramid (inverted triangle)
      for (let r = 0; r < rows; r++) {
        const indent = r;
        for (let c = indent; c < cols - indent; c++)
          addBlock(r, c, r === 0);
      }
      break;
    }

    case 3: // Checkerboard
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
          if ((r + c) % 2 === 0)
            addBlock(r, c, r < 2);
      break;

    case 4: { // Fortress (walls with gap)
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const isGap = c >= Math.floor(cols / 2) - 1 && c <= Math.floor(cols / 2) && r >= 2 && r <= rows - 2;
          if (!isGap) addBlock(r, c, c === 0 || c === cols - 1);
        }
      }
      break;
    }

    case 5: { // Diamond
      const midC = (cols - 1) / 2;
      const midR = (rows - 1) / 2;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const dist = Math.abs(c - midC) / midC + Math.abs(r - midR) / midR;
          if (dist <= 1.05) addBlock(r, c, dist < 0.4);
        }
      }
      break;
    }

    case 6: // Random
    default:
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
          if (Math.random() > 0.3)
            addBlock(r, c, Math.random() < 0.25);
      break;
  }

  return blocks;
}

export default function BlockBreakerGame({ onAddHighscore, paused = false }: BlockBreakerGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 400, h: 400 });
  const [gameState, setGameState] = useState<GameState>("idle");
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(MAX_LIVES);
  const [level, setLevel] = useState(1);
  const [bestScore, setBestScore] = useState(0);

  const gameStateRef = useRef<GameState>("idle");
  const scoreRef = useRef(0);
  const livesRef = useRef(MAX_LIVES);
  const levelRef = useRef(1);
  const ballRef = useRef<Ball>({ x: 200, y: 350, vx: 2, vy: -3.5, radius: BALL_RADIUS });
  const paddleRef = useRef<Paddle>({ x: 170, y: 380, w: 60, h: PADDLE_HEIGHT });
  const blocksRef = useRef<Block[]>([]);
  const keysRef = useRef<Set<string>>(new Set());
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const mouseXRef = useRef<number | null>(null);
  const canvasSizeRef = useRef(canvasSize);
  canvasSizeRef.current = canvasSize;

  // Resize observer
  useEffect(() => {
    const container = containerRef.current?.querySelector("[data-canvas-area]") as HTMLElement | null;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setCanvasSize({ w: Math.floor(width), h: Math.floor(height) });
        }
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  const resetBallAndPaddle = useCallback((cw: number, ch: number) => {
    const pw = cw * 0.15;
    paddleRef.current = {
      x: (cw - pw) / 2,
      y: ch - 30,
      w: pw,
      h: PADDLE_HEIGHT,
    };
    const speed = INITIAL_BALL_SPEED * (1 + (levelRef.current - 1) * 0.1);
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 0.6;
    ballRef.current = {
      x: cw / 2,
      y: paddleRef.current.y - BALL_RADIUS - 2,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: BALL_RADIUS,
    };
  }, []);

  const initLevel = useCallback((lvl: number, cw: number, ch: number) => {
    const blockAreaTop = 10;
    const blockAreaH = ch * 0.4;
    blocksRef.current = generateBlocks(lvl, cw, blockAreaH, blockAreaTop);
    resetBallAndPaddle(cw, ch);
  }, [resetBallAndPaddle]);

  const startGame = useCallback(() => {
    const { w, h } = canvasSizeRef.current;
    scoreRef.current = 0;
    livesRef.current = MAX_LIVES;
    levelRef.current = 1;
    setScore(0);
    setLives(MAX_LIVES);
    setLevel(1);
    initLevel(1, w, h);
    setGameState("playing");
    gameStateRef.current = "playing";
    lastTimeRef.current = 0;
  }, [initLevel]);

  const nextLevel = useCallback(() => {
    const { w, h } = canvasSizeRef.current;
    const lvl = levelRef.current + 1;
    levelRef.current = lvl;
    setLevel(lvl);
    initLevel(lvl, w, h);
    setGameState("playing");
    gameStateRef.current = "playing";
    lastTimeRef.current = 0;
  }, [initLevel]);

  // Draw
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { w, h } = canvasSizeRef.current;
    canvas.width = w;
    canvas.height = h;

    const bgColor = getComputedColor("--ezy-bg", "#0d0d0d");
    const borderColor = getComputedColor("--ezy-border", "#2a2a2a");
    const accentColor = getComputedColor("--ezy-accent", "#5eead4");
    const surfaceRaised = getComputedColor("--ezy-surface-raised", "#1e1e1e");

    // Background
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, w, h);

    // Subtle grid
    ctx.strokeStyle = borderColor;
    ctx.globalAlpha = 0.1;
    ctx.lineWidth = 1;
    const gridStep = 30;
    for (let x = 0; x <= w; x += gridStep) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y += gridStep) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Blocks
    const blocks = blocksRef.current;
    for (const block of blocks) {
      if (block.hits <= 0) continue;
      if (block.hits === 2) {
        // Tough block — brighter fill with border
        ctx.fillStyle = lightenColor(surfaceRaised, 30);
        ctx.strokeStyle = hexToRgba(accentColor, 0.4);
        ctx.lineWidth = 1.5;
        const br = 3;
        ctx.beginPath();
        ctx.moveTo(block.x + br, block.y);
        ctx.arcTo(block.x + block.w, block.y, block.x + block.w, block.y + block.h, br);
        ctx.arcTo(block.x + block.w, block.y + block.h, block.x, block.y + block.h, br);
        ctx.arcTo(block.x, block.y + block.h, block.x, block.y, br);
        ctx.arcTo(block.x, block.y, block.x + block.w, block.y, br);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        // Normal block
        ctx.fillStyle = surfaceRaised;
        const br = 3;
        ctx.beginPath();
        ctx.moveTo(block.x + br, block.y);
        ctx.arcTo(block.x + block.w, block.y, block.x + block.w, block.y + block.h, br);
        ctx.arcTo(block.x + block.w, block.y + block.h, block.x, block.y + block.h, br);
        ctx.arcTo(block.x, block.y + block.h, block.x, block.y, br);
        ctx.arcTo(block.x, block.y, block.x + block.w, block.y, br);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Paddle — rounded rect with accent top border
    const paddle = paddleRef.current;
    const pr = paddle.h / 2;
    ctx.fillStyle = surfaceRaised;
    ctx.beginPath();
    ctx.moveTo(paddle.x + pr, paddle.y);
    ctx.arcTo(paddle.x + paddle.w, paddle.y, paddle.x + paddle.w, paddle.y + paddle.h, pr);
    ctx.arcTo(paddle.x + paddle.w, paddle.y + paddle.h, paddle.x, paddle.y + paddle.h, pr);
    ctx.arcTo(paddle.x, paddle.y + paddle.h, paddle.x, paddle.y, pr);
    ctx.arcTo(paddle.x, paddle.y, paddle.x + paddle.w, paddle.y, pr);
    ctx.closePath();
    ctx.fill();

    // Accent line on top of paddle
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(paddle.x + pr, paddle.y + 1);
    ctx.lineTo(paddle.x + paddle.w - pr, paddle.y + 1);
    ctx.stroke();
    ctx.lineCap = "butt";

    // Ball — glowing circle
    const ball = ballRef.current;
    ctx.fillStyle = accentColor;
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }, []);

  // Game loop
  useEffect(() => {
    if (gameState !== "playing" || paused) {
      // Still draw the current state once
      draw();
      return;
    }

    const PADDLE_SPEED = 7;

    function gameLoop(time: number) {
      if (gameStateRef.current !== "playing" || pausedRef.current) return;

      if (lastTimeRef.current === 0) lastTimeRef.current = time;
      const dt = Math.min((time - lastTimeRef.current) / 16.667, 3); // normalize to ~60fps, cap at 3x
      lastTimeRef.current = time;

      const { w, h } = canvasSizeRef.current;
      const paddle = paddleRef.current;
      const ball = ballRef.current;
      const blocks = blocksRef.current;

      // Move paddle via keyboard
      if (keysRef.current.has("ArrowLeft") || keysRef.current.has("a") || keysRef.current.has("A")) {
        paddle.x = Math.max(0, paddle.x - PADDLE_SPEED * dt);
      }
      if (keysRef.current.has("ArrowRight") || keysRef.current.has("d") || keysRef.current.has("D")) {
        paddle.x = Math.min(w - paddle.w, paddle.x + PADDLE_SPEED * dt);
      }

      // Move paddle via mouse
      if (mouseXRef.current !== null) {
        paddle.x = Math.max(0, Math.min(w - paddle.w, mouseXRef.current - paddle.w / 2));
      }

      // Move ball
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;

      // Wall collisions
      if (ball.x - ball.radius <= 0) {
        ball.x = ball.radius;
        ball.vx = Math.abs(ball.vx);
      }
      if (ball.x + ball.radius >= w) {
        ball.x = w - ball.radius;
        ball.vx = -Math.abs(ball.vx);
      }
      if (ball.y - ball.radius <= 0) {
        ball.y = ball.radius;
        ball.vy = Math.abs(ball.vy);
      }

      // Ball fell below
      if (ball.y + ball.radius > h) {
        livesRef.current -= 1;
        setLives(livesRef.current);
        if (livesRef.current <= 0) {
          // Game over
          gameStateRef.current = "over";
          setGameState("over");
          if (scoreRef.current > 0) onAddHighscore(scoreRef.current);
          setBestScore((prev) => Math.max(prev, scoreRef.current));
          draw();
          return;
        }
        // Reset ball/paddle, continue
        resetBallAndPaddle(w, h);
        lastTimeRef.current = 0;
        draw();
        rafRef.current = requestAnimationFrame(gameLoop);
        return;
      }

      // Paddle collision
      if (
        ball.vy > 0 &&
        ball.y + ball.radius >= paddle.y &&
        ball.y + ball.radius <= paddle.y + paddle.h + 4 &&
        ball.x >= paddle.x &&
        ball.x <= paddle.x + paddle.w
      ) {
        // Calculate angle based on hit position
        const hitPos = (ball.x - paddle.x) / paddle.w; // 0..1
        const angle = -Math.PI / 3 + hitPos * (2 * Math.PI / 3); // -60deg to +60deg
        const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
        ball.vx = Math.sin(angle) * speed;
        ball.vy = -Math.cos(angle) * speed;
        // Ensure vy has minimum magnitude to prevent stuck loops
        if (Math.abs(ball.vy) < MIN_VY) {
          ball.vy = ball.vy < 0 ? -MIN_VY : MIN_VY;
        }
        ball.y = paddle.y - ball.radius;
      }

      // Block collisions
      let rowsCleared = new Set<number>();
      for (const block of blocks) {
        if (block.hits <= 0) continue;

        // AABB collision check with ball as a point expanded by radius
        const closestX = Math.max(block.x, Math.min(ball.x, block.x + block.w));
        const closestY = Math.max(block.y, Math.min(ball.y, block.y + block.h));
        const dx = ball.x - closestX;
        const dy = ball.y - closestY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist <= ball.radius) {
          const wasTough = block.hits === 2;
          block.hits -= 1;

          // Score
          scoreRef.current += wasTough && block.hits > 0 ? 0 : wasTough ? 20 : 10;
          setScore(scoreRef.current);

          // Determine bounce direction
          const overlapX = ball.radius - Math.abs(dx);
          const overlapY = ball.radius - Math.abs(dy);

          if (overlapX < overlapY) {
            ball.vx = -ball.vx;
            ball.x += ball.vx > 0 ? overlapX : -overlapX;
          } else {
            ball.vy = -ball.vy;
            ball.y += ball.vy > 0 ? overlapY : -overlapY;
          }

          // Ensure vy doesn't get stuck near zero
          if (Math.abs(ball.vy) < MIN_VY) {
            ball.vy = ball.vy < 0 ? -MIN_VY : MIN_VY;
          }

          // Track row for row-clear bonus
          if (block.hits <= 0) {
            rowsCleared.add(block.row);
          }

          break; // One collision per frame
        }
      }

      // Row clear bonus — check if any tracked rows are fully destroyed
      for (const row of rowsCleared) {
        const rowBlocks = blocks.filter((b) => b.row === row);
        const allDestroyed = rowBlocks.every((b) => b.hits <= 0);
        if (allDestroyed && rowBlocks.length > 0) {
          scoreRef.current += 50;
          setScore(scoreRef.current);
        }
      }

      // Check if all blocks destroyed
      const remainingBlocks = blocks.filter((b) => b.hits > 0);
      if (remainingBlocks.length === 0) {
        // Level clear bonus
        scoreRef.current += levelRef.current * 100;
        setScore(scoreRef.current);
        gameStateRef.current = "levelClear";
        setGameState("levelClear");
        draw();
        return;
      }

      draw();
      rafRef.current = requestAnimationFrame(gameLoop);
    }

    rafRef.current = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [gameState, paused, draw, onAddHighscore, resetBallAndPaddle]);

  // Key handlers
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "a" || e.key === "A" || e.key === "d" || e.key === "D") {
        e.preventDefault();
        e.stopPropagation();
        keysRef.current.add(e.key);
      }
      if (e.key === " " && gameStateRef.current === "idle") {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key);
    };

    container.addEventListener("keydown", handleKeyDown);
    container.addEventListener("keyup", handleKeyUp);
    return () => {
      container.removeEventListener("keydown", handleKeyDown);
      container.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  // Mouse handler
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseXRef.current = e.clientX - rect.left;
    };

    const handleMouseLeave = () => {
      mouseXRef.current = null;
    };

    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);
    return () => {
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, []);

  // Redraw on size changes
  useEffect(() => {
    draw();
  }, [draw, canvasSize]);

  // Focus container on state changes
  useEffect(() => {
    containerRef.current?.focus();
  }, [gameState]);

  // Render lives as small circles
  const renderLives = () => {
    const circles: React.ReactNode[] = [];
    for (let i = 0; i < MAX_LIVES; i++) {
      const filled = i < lives;
      circles.push(
        <span
          key={i}
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            backgroundColor: filled ? "var(--ezy-accent)" : "transparent",
            border: filled ? "none" : "1.5px solid var(--ezy-text-muted)",
            marginLeft: i > 0 ? 4 : 0,
          }}
        />,
      );
    }
    return circles;
  };

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
          fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)",
        }}
      >
        <span>
          Score: <span style={{ color: "var(--ezy-accent)" }}>{score}</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: "var(--ezy-text-muted)" }}>Lvl {level}</span>
          <span style={{ display: "flex", alignItems: "center" }}>{renderLives()}</span>
        </span>
        {bestScore > 0 && <span>Best: {bestScore}</span>}
      </div>

      {/* Canvas area */}
      <div
        data-canvas-area
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <canvas ref={canvasRef} style={{ display: "block" }} />

        {/* Idle / Game Over overlay */}
        {(gameState === "idle" || gameState === "over") && (
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
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ezy-text)" }}>
                  Game Over
                </div>
                <div style={{ fontSize: 14, color: "var(--ezy-accent)", fontWeight: 600 }}>
                  Score: {score}
                </div>
                {score > 0 && score >= bestScore && (
                  <div style={{ fontSize: 12, color: "#4ade80", fontWeight: 600 }}>
                    New Highscore!
                  </div>
                )}
              </>
            )}
            {gameState === "idle" && (
              <div
                style={{
                  fontSize: 14,
                  color: "var(--ezy-text-secondary)",
                  marginBottom: 4,
                }}
              >
                Arrow keys or mouse to move paddle
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

        {/* Level clear overlay */}
        {gameState === "levelClear" && (
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
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ezy-accent)" }}>
              Level {level} Complete!
            </div>
            <div style={{ fontSize: 13, color: "var(--ezy-text-secondary)" }}>
              Bonus: +{level * 100}
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                nextLevel();
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
              Next Level
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
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ezy-text-muted)" }}>
              Paused
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

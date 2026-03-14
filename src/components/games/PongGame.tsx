import { useRef, useEffect, useState, useCallback } from "react";

interface PongGameProps {
  onUpdateStats: (result: "win" | "loss") => void;
  paused?: boolean;
}

type Difficulty = "easy" | "medium" | "hard";
type GamePhase = "select" | "idle" | "playing" | "scored" | "over";

const WIN_SCORE = 6;

const AI_CONFIG: Record<Difficulty, { speed: number; reaction: number; maxSpeed: number; errorMargin: number }> = {
  easy: { speed: 0.35, reaction: 18, maxSpeed: 2, errorMargin: 60 },
  medium: { speed: 0.55, reaction: 12, maxSpeed: 3, errorMargin: 40 },
  hard: { speed: 0.94, reaction: 2, maxSpeed: 7.5, errorMargin: 4 },
};

function getComputedColor(varName: string, fallback: string): string {
  const val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return val || fallback;
}

export default function PongGame({ onUpdateStats, paused = false }: PongGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [difficulty, setDifficulty] = useState<Difficulty | null>(null);
  const [phase, setPhase] = useState<GamePhase>("select");
  const [playerScore, setPlayerScore] = useState(0);
  const [aiScore, setAiScore] = useState(0);
  const [canvasSize, setCanvasSize] = useState({ w: 400, h: 300 });
  const [useMouse, setUseMouse] = useState(false);

  const phaseRef = useRef<GamePhase>("select");
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Game state refs
  const playerY = useRef(0);
  const aiY = useRef(0);
  const ballX = useRef(0);
  const ballY = useRef(0);
  const ballVX = useRef(0);
  const ballVY = useRef(0);
  const playerScoreRef = useRef(0);
  const aiScoreRef = useRef(0);
  const aiTargetY = useRef(0);
  const aiUpdateCounter = useRef(0);
  const keysDown = useRef<Set<string>>(new Set());
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const serveDir = useRef<1 | -1>(1); // 1 = toward AI, -1 = toward player
  const serveHitRef = useRef(false); // true after first paddle hit of a rally
  const mouseYRef = useRef<number | null>(null);
  const useMouseRef = useRef(useMouse);
  useMouseRef.current = useMouse;

  const PADDLE_W = 10;
  const PADDLE_H_RATIO = 0.18; // proportion of canvas height
  const BALL_R = 5;
  const PADDLE_MARGIN = 16;
  const BASE_BALL_SPEED = 480; // px/sec
  const PLAYER_PADDLE_SPEED = 520; // px/sec

  const getPaddleH = useCallback(() => Math.max(40, canvasSize.h * PADDLE_H_RATIO), [canvasSize.h]);

  const resetBall = useCallback((dir: 1 | -1) => {
    const { w, h } = canvasSize;
    ballX.current = w / 2;
    ballY.current = h / 2;
    serveHitRef.current = false;
    const angle = (Math.random() * 0.8 - 0.4); // -0.4 to 0.4 radians
    const speed = BASE_BALL_SPEED * 0.5; // slow serve, jumps to full speed on first hit
    ballVX.current = Math.cos(angle) * speed * dir;
    ballVY.current = Math.sin(angle) * speed;
  }, [canvasSize]);

  const initGame = useCallback(() => {
    const { h } = canvasSize;
    const pH = getPaddleH();
    playerY.current = h / 2 - pH / 2;
    aiY.current = h / 2 - pH / 2;
    playerScoreRef.current = 0;
    aiScoreRef.current = 0;
    setPlayerScore(0);
    setAiScore(0);
    serveDir.current = 1;
    resetBall(1);
    setPhase("playing");
    phaseRef.current = "playing";
    lastTimeRef.current = 0;
  }, [canvasSize, getPaddleH, resetBall]);

  // ResizeObserver — measure canvas area, full width, proportional height
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const area = canvasAreaRef.current;
    if (!area) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          const cw = Math.floor(width);
          const ch = Math.floor(height);
          const canvasH = Math.min(Math.floor(cw * 0.55), ch);
          setCanvasSize({ w: cw, h: canvasH });
        }
      }
    });
    ro.observe(area);
    return () => ro.disconnect();
  }, [phase]);

  // Key handlers — scoped to container so they don't steal keys from CLI panes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const down = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "w", "W", "s", "S"].includes(e.key)) {
        e.preventDefault();
        keysDown.current.add(e.key);
      }
    };
    const up = (e: KeyboardEvent) => keysDown.current.delete(e.key);
    container.addEventListener("keydown", down);
    container.addEventListener("keyup", up);
    return () => {
      container.removeEventListener("keydown", down);
      container.removeEventListener("keyup", up);
    };
  }, []);

  // Mouse tracking for mouse control mode — listen on canvas directly
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseYRef.current = e.clientY - rect.top;
    };
    const handleMouseLeave = () => { mouseYRef.current = null; };
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mouseleave", handleMouseLeave);
    return () => {
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [phase]);

  // Game loop
  useEffect(() => {
    if (phase !== "playing" || paused || !difficulty) return;

    const config = AI_CONFIG[difficulty];

    function loop(time: number) {
      if (phaseRef.current !== "playing" || pausedRef.current) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      if (!lastTimeRef.current) lastTimeRef.current = time;
      const dt = Math.min((time - lastTimeRef.current) / 1000, 0.05); // cap at 50ms
      lastTimeRef.current = time;

      const { w, h } = canvasSize;
      const pH = getPaddleH();

      // --- Player paddle movement ---
      if (useMouseRef.current && mouseYRef.current !== null) {
        // Mouse mode: paddle center follows mouse Y
        const targetY = mouseYRef.current - pH / 2;
        playerY.current = Math.max(0, Math.min(h - pH, targetY));
      } else {
        // Keyboard mode
        const keys = keysDown.current;
        if (keys.has("ArrowUp") || keys.has("w") || keys.has("W")) {
          playerY.current = Math.max(0, playerY.current - PLAYER_PADDLE_SPEED * dt);
        }
        if (keys.has("ArrowDown") || keys.has("s") || keys.has("S")) {
          playerY.current = Math.min(h - pH, playerY.current + PLAYER_PADDLE_SPEED * dt);
        }
      }

      // --- AI paddle movement ---
      aiUpdateCounter.current++;
      if (aiUpdateCounter.current >= config.reaction) {
        aiUpdateCounter.current = 0;
        aiTargetY.current = ballY.current - pH / 2 + (Math.random() - 0.5) * config.errorMargin;
      }
      const aiDiff = aiTargetY.current - aiY.current;
      const aiMaxMove = config.maxSpeed * 60 * dt;
      const aiMove = Math.sign(aiDiff) * Math.min(Math.abs(aiDiff) * config.speed, aiMaxMove);
      aiY.current = Math.max(0, Math.min(h - pH, aiY.current + aiMove));

      // --- Ball movement ---
      // Time-based acceleration: only after first paddle hit
      if (serveHitRef.current) {
        const maxSpeed = BASE_BALL_SPEED * 1.6;
        const currentSpeed = Math.sqrt(ballVX.current ** 2 + ballVY.current ** 2);
        if (currentSpeed < maxSpeed) {
          const accel = 1 + 0.005 * dt; // 0.5% per second
          ballVX.current *= accel;
          ballVY.current *= accel;
        }
      }

      ballX.current += ballVX.current * dt;
      ballY.current += ballVY.current * dt;

      // Top/bottom wall bounce
      if (ballY.current - BALL_R <= 0) {
        ballY.current = BALL_R;
        ballVY.current = Math.abs(ballVY.current);
      }
      if (ballY.current + BALL_R >= h) {
        ballY.current = h - BALL_R;
        ballVY.current = -Math.abs(ballVY.current);
      }

      // Paddle collision — player (left)
      const pLeft = PADDLE_MARGIN;
      const pRight = PADDLE_MARGIN + PADDLE_W;
      if (
        ballX.current - BALL_R <= pRight &&
        ballX.current + BALL_R >= pLeft &&
        ballY.current >= playerY.current &&
        ballY.current <= playerY.current + pH &&
        ballVX.current < 0
      ) {
        ballX.current = pRight + BALL_R;
        const hitPos = (ballY.current - playerY.current) / pH; // 0..1
        const angle = (hitPos - 0.5) * 1.2; // -0.6 to 0.6 radians
        const curSpeed = Math.sqrt(ballVX.current ** 2 + ballVY.current ** 2);
        // First hit: jump to full speed. After: 4% bump per hit
        const newSpeed = !serveHitRef.current ? BASE_BALL_SPEED : curSpeed * 1.04;
        const cappedSpeed = Math.min(newSpeed, BASE_BALL_SPEED * 1.6);
        serveHitRef.current = true;
        ballVX.current = Math.cos(angle) * cappedSpeed;
        ballVY.current = Math.sin(angle) * cappedSpeed;
        if (ballVX.current < 0) ballVX.current = -ballVX.current;
      }

      // Paddle collision — AI (right)
      const aLeft = w - PADDLE_MARGIN - PADDLE_W;
      const aRight = w - PADDLE_MARGIN;
      if (
        ballX.current + BALL_R >= aLeft &&
        ballX.current - BALL_R <= aRight &&
        ballY.current >= aiY.current &&
        ballY.current <= aiY.current + pH &&
        ballVX.current > 0
      ) {
        ballX.current = aLeft - BALL_R;
        const hitPos = (ballY.current - aiY.current) / pH;
        const angle = (hitPos - 0.5) * 1.2;
        const curSpeed = Math.sqrt(ballVX.current ** 2 + ballVY.current ** 2);
        const newSpeed = !serveHitRef.current ? BASE_BALL_SPEED : curSpeed * 1.04;
        const cappedSpeed = Math.min(newSpeed, BASE_BALL_SPEED * 1.6);
        serveHitRef.current = true;
        ballVX.current = -Math.cos(angle) * cappedSpeed;
        ballVY.current = Math.sin(angle) * cappedSpeed;
        if (ballVX.current > 0) ballVX.current = -ballVX.current;
      }

      // Ensure minimum vertical speed to prevent stuck horizontal bouncing
      if (Math.abs(ballVY.current) < 30) {
        ballVY.current = 30 * Math.sign(ballVY.current || 1);
      }

      // --- Scoring ---
      if (ballX.current - BALL_R <= 0) {
        // AI scores
        aiScoreRef.current++;
        setAiScore(aiScoreRef.current);
        if (aiScoreRef.current >= WIN_SCORE) {
          phaseRef.current = "over";
          setPhase("over");
          onUpdateStats("loss");
        } else {
          serveDir.current = -1; // serve toward player (loser)
          resetBall(-1);
        }
      } else if (ballX.current + BALL_R >= w) {
        // Player scores
        playerScoreRef.current++;
        setPlayerScore(playerScoreRef.current);
        if (playerScoreRef.current >= WIN_SCORE) {
          phaseRef.current = "over";
          setPhase("over");
          onUpdateStats("win");
        } else {
          serveDir.current = 1; // serve toward AI (loser)
          resetBall(1);
        }
      }

      // --- Draw ---
      draw();

      rafRef.current = requestAnimationFrame(loop);
    }

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, paused, difficulty, canvasSize, getPaddleH, resetBall, onUpdateStats]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { w, h } = canvasSize;
    canvas.width = w;
    canvas.height = h;
    const pH = getPaddleH();

    const bgColor = getComputedColor("--ezy-bg", "#0d0d0d");
    const accentColor = getComputedColor("--ezy-accent", "#5eead4");
    const borderColor = getComputedColor("--ezy-border", "#2a2a2a");
    const surfaceRaised = getComputedColor("--ezy-surface-raised", "#1f1f1f");
    const textColor = getComputedColor("--ezy-text", "#e5e5e5");

    // Background
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, w, h);

    // Center dashed line
    ctx.strokeStyle = borderColor;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Top & bottom borders
    ctx.strokeStyle = borderColor;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 1);
    ctx.lineTo(w, 1);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, h - 1);
    ctx.lineTo(w, h - 1);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Score text
    ctx.font = `bold ${Math.max(20, Math.floor(h / 10))}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = textColor;
    ctx.globalAlpha = 0.25;
    ctx.fillText(String(playerScoreRef.current), w / 4, 16);
    ctx.fillText(String(aiScoreRef.current), (3 * w) / 4, 16);
    ctx.globalAlpha = 1;

    // Player paddle (left)
    ctx.fillStyle = surfaceRaised;
    const pX = PADDLE_MARGIN;
    roundRect(ctx, pX, playerY.current, PADDLE_W, pH, 4);
    ctx.fill();
    // Accent edge
    ctx.fillStyle = accentColor;
    ctx.fillRect(pX + PADDLE_W - 2, playerY.current + 2, 2, pH - 4);

    // AI paddle (right)
    ctx.fillStyle = surfaceRaised;
    const aX = w - PADDLE_MARGIN - PADDLE_W;
    roundRect(ctx, aX, aiY.current, PADDLE_W, pH, 4);
    ctx.fill();
    // Accent edge
    ctx.fillStyle = accentColor;
    ctx.fillRect(aX, aiY.current + 2, 2, pH - 4);

    // Ball
    ctx.fillStyle = accentColor;
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(ballX.current, ballY.current, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }, [canvasSize, getPaddleH]);

  // Draw on size changes or when idle
  useEffect(() => {
    if (phase === "select") return;
    draw();
  }, [draw, phase, canvasSize]);

  useEffect(() => { containerRef.current?.focus(); }, [phase]);

  if (phase === "select") {
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
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ezy-text)", marginBottom: 8, fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)" }}>
            Select Difficulty
          </div>
          {(["easy", "medium", "hard"] as Difficulty[]).map((d) => (
            <div
              key={d}
              onClick={() => { setDifficulty(d); setPhase("idle"); phaseRef.current = "idle"; }}
              style={{
                width: "100%",
                maxWidth: 240,
                padding: "10px 16px",
                borderRadius: 6,
                backgroundColor: "var(--ezy-surface)",
                border: "1px solid var(--ezy-border)",
                cursor: "pointer",
                textAlign: "center",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--ezy-text)",
                transition: "background-color 150ms ease, border-color 150ms ease",
                fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)",
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
              {d.charAt(0).toUpperCase() + d.slice(1)}
              <div style={{ fontSize: 10, color: "var(--ezy-text-muted)", marginTop: 2, fontWeight: 400 }}>
                {d === "easy" ? "Relaxed AI, slow reactions" : d === "medium" ? "Balanced challenge" : "Near-perfect AI"}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const playerWon = playerScoreRef.current >= WIN_SCORE;

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
          You: <span style={{ color: "var(--ezy-accent)" }}>{playerScore}</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: "var(--ezy-text-muted)" }}>
            First to {WIN_SCORE} {difficulty ? `(${difficulty})` : ""}
          </span>
          <span
            onClick={() => setUseMouse((v) => !v)}
            style={{
              fontSize: 9,
              fontWeight: 600,
              padding: "1px 6px",
              borderRadius: 3,
              cursor: "pointer",
              backgroundColor: useMouse ? "var(--ezy-accent)" : "var(--ezy-surface-raised)",
              color: useMouse ? "var(--ezy-bg)" : "var(--ezy-text-muted)",
              border: useMouse ? "none" : "1px solid var(--ezy-border)",
              transition: "background-color 150ms ease, color 150ms ease",
              userSelect: "none",
            }}
            title={useMouse ? "Switch to keyboard controls" : "Switch to mouse controls"}
          >
            {useMouse ? "MOUSE" : "KEYS"}
          </span>
        </span>
        <span>
          AI: <span style={{ color: "#f87171" }}>{aiScore}</span>
        </span>
      </div>

      {/* Canvas area */}
      <div ref={canvasAreaRef} data-canvas-area style={{
        flex: 1,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--ezy-bg)",
        minHeight: 0,
        cursor: useMouse && phase === "playing" && !paused ? "none" : "default",
      }}>
        <canvas ref={canvasRef} style={{ display: "block" }} />

        {/* Idle overlay */}
        {phase === "idle" && (
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
            <div style={{ fontSize: 14, color: "var(--ezy-text-secondary)", fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)" }}>
              {useMouse ? "Move mouse to control paddle" : "W/S or Arrow keys to move"}
            </div>
            <div
              onClick={() => { initGame(); setTimeout(() => containerRef.current?.focus(), 50); }}
              style={{
                padding: "8px 24px",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--ezy-bg)",
                backgroundColor: "var(--ezy-accent)",
                borderRadius: 6,
                cursor: "pointer",
                transition: "opacity 150ms ease",
                fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
            >
              Start Match
            </div>
          </div>
        )}

        {/* Game over overlay */}
        {phase === "over" && (
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
            <div style={{ fontSize: 18, fontWeight: 700, color: playerWon ? "#4ade80" : "#f87171", fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)" }}>
              {playerWon ? "You Win!" : "You Lose"}
            </div>
            <div style={{ fontSize: 14, color: "var(--ezy-text-secondary)", fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)" }}>
              {playerScore} - {aiScore}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div
                onClick={() => { initGame(); setTimeout(() => containerRef.current?.focus(), 50); }}
                style={{
                  padding: "8px 20px",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--ezy-bg)",
                  backgroundColor: "var(--ezy-accent)",
                  borderRadius: 6,
                  cursor: "pointer",
                  transition: "opacity 150ms ease",
                  fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
              >
                Play Again
              </div>
              <div
                onClick={() => { setPhase("select"); phaseRef.current = "select"; setDifficulty(null); }}
                style={{
                  padding: "8px 20px",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--ezy-text-secondary)",
                  backgroundColor: "var(--ezy-surface)",
                  border: "1px solid var(--ezy-border)",
                  borderRadius: 6,
                  cursor: "pointer",
                  transition: "opacity 150ms ease",
                  fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
              >
                Change Difficulty
              </div>
            </div>
          </div>
        )}

        {/* Pause overlay */}
        {paused && phase === "playing" && (
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
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ezy-text-muted)", fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)" }}>Paused</div>
          </div>
        )}
      </div>
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

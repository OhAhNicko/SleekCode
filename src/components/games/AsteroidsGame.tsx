import { useRef, useEffect, useState, useCallback } from "react";

interface AsteroidsGameProps {
  onAddHighscore: (score: number) => void;
  paused?: boolean;
}

type GamePhase = "idle" | "playing" | "dying" | "over";

/* ---- Constants (256x256 @ 30 fps) ---- */
const W = 256;
const H = 256;
const FRAME_MS = 1000 / 30;

const SHIP_RADIUS = 8;
const THRUST_ACCEL = 0.28;
const FRICTION = 0.99;
const MAX_SPEED = 4.5;
const ROTATE_SPEED = 0.09;
const BULLET_SPEED = 5;
const BULLET_LIFE = 60;
const MAX_BULLETS = 4;
const INVULN_FRAMES = 90; // 3 seconds at 30fps
const BONUS_LIFE_SCORE = 10000;
const WAVE_DELAY_FRAMES = 60; // 2 seconds pause between waves

const ASTEROID_SIZES = {
  large: { radius: 20, points: 20, splits: 2, childSize: "medium" as const },
  medium: { radius: 12, points: 50, splits: 2, childSize: "small" as const },
  small: { radius: 6, points: 100, splits: 0, childSize: "small" as const },
};

type AsteroidSize = keyof typeof ASTEROID_SIZES;

interface Vec2 { x: number; y: number }

interface Ship {
  pos: Vec2;
  vel: Vec2;
  angle: number;
  thrusting: boolean;
}

interface Bullet {
  pos: Vec2;
  vel: Vec2;
  life: number;
}

interface Asteroid {
  pos: Vec2;
  vel: Vec2;
  size: AsteroidSize;
  rotation: number;
  rotSpeed: number;
  vertices: number[]; // radius offsets for each vertex
  vertexCount: number;
}

interface Particle {
  pos: Vec2;
  vel: Vec2;
  life: number;
  maxLife: number;
}

interface Star {
  x: number;
  y: number;
  brightness: number;
}

/* ---- Helpers ---- */

function wrap(v: Vec2): Vec2 {
  let { x, y } = v;
  if (x < 0) x += W;
  if (x >= W) x -= W;
  if (y < 0) y += H;
  if (y >= H) y -= H;
  return { x, y };
}

function dist(a: Vec2, b: Vec2): number {
  // account for wrapping
  let dx = Math.abs(a.x - b.x);
  let dy = Math.abs(a.y - b.y);
  if (dx > W / 2) dx = W - dx;
  if (dy > H / 2) dy = H - dy;
  return Math.sqrt(dx * dx + dy * dy);
}

function genAsteroidVertices(count: number): number[] {
  const verts: number[] = [];
  for (let i = 0; i < count; i++) {
    verts.push(0.7 + Math.random() * 0.6); // radius multiplier 0.7 - 1.3
  }
  return verts;
}

function spawnAsteroid(size: AsteroidSize, pos?: Vec2, vel?: Vec2): Asteroid {
  const vertexCount = 8 + Math.floor(Math.random() * 5); // 8-12 vertices
  const speed = size === "large" ? 0.5 + Math.random() * 1.0
    : size === "medium" ? 0.8 + Math.random() * 1.2
    : 1.0 + Math.random() * 1.5;
  const angle = Math.random() * Math.PI * 2;

  return {
    pos: pos ?? { x: Math.random() * W, y: Math.random() * H },
    vel: vel ?? { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
    size,
    rotation: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.04,
    vertices: genAsteroidVertices(vertexCount),
    vertexCount,
  };
}

function spawnWaveAsteroids(wave: number, shipPos: Vec2): Asteroid[] {
  const count = 3 + wave; // Wave 1 = 4, Wave 2 = 5, etc.
  const asteroids: Asteroid[] = [];
  for (let i = 0; i < count; i++) {
    let pos: Vec2;
    // spawn away from ship (at least 60px)
    let attempts = 0;
    do {
      pos = { x: Math.random() * W, y: Math.random() * H };
      attempts++;
    } while (dist(pos, shipPos) < 60 && attempts < 50);
    asteroids.push(spawnAsteroid("large", pos));
  }
  return asteroids;
}

function genStars(count: number): Star[] {
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random() * W,
      y: Math.random() * H,
      brightness: 0.2 + Math.random() * 0.6,
    });
  }
  return stars;
}

/* ---- Drawing helpers ---- */

function drawShip(ctx: CanvasRenderingContext2D, ship: Ship, blink: boolean) {
  if (blink) return; // invulnerability blink: skip draw on odd frames
  const { x, y } = ship.pos;
  const a = ship.angle;
  const r = SHIP_RADIUS;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);

  // Ship body (triangle)
  ctx.beginPath();
  ctx.moveTo(r, 0);                              // nose
  ctx.lineTo(-r * 0.7, -r * 0.6);                // top-left
  ctx.lineTo(-r * 0.4, 0);                       // indent
  ctx.lineTo(-r * 0.7, r * 0.6);                 // bottom-left
  ctx.closePath();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Thrust flame
  if (ship.thrusting) {
    const flicker = 0.5 + Math.random() * 0.5;
    ctx.beginPath();
    ctx.moveTo(-r * 0.4, -r * 0.25);
    ctx.lineTo(-r * 0.4 - r * 0.6 * flicker, 0);
    ctx.lineTo(-r * 0.4, r * 0.25);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.restore();
}

function drawAsteroid(ctx: CanvasRenderingContext2D, asteroid: Asteroid) {
  const { x, y } = asteroid.pos;
  const info = ASTEROID_SIZES[asteroid.size];
  const r = info.radius;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(asteroid.rotation);

  ctx.beginPath();
  for (let i = 0; i < asteroid.vertexCount; i++) {
    const angle = (i / asteroid.vertexCount) * Math.PI * 2;
    const vr = r * asteroid.vertices[i];
    const vx = Math.cos(angle) * vr;
    const vy = Math.sin(angle) * vr;
    if (i === 0) ctx.moveTo(vx, vy);
    else ctx.lineTo(vx, vy);
  }
  ctx.closePath();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

function drawBullet(ctx: CanvasRenderingContext2D, bullet: Bullet) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(Math.floor(bullet.pos.x) - 1, Math.floor(bullet.pos.y) - 1, 2, 2);
}

function drawParticle(ctx: CanvasRenderingContext2D, p: Particle) {
  const alpha = p.life / p.maxLife;
  ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(p.pos.x, p.pos.y);
  ctx.lineTo(p.pos.x - p.vel.x * 0.3, p.pos.y - p.vel.y * 0.3);
  ctx.stroke();
}

function drawLives(ctx: CanvasRenderingContext2D, lives: number) {
  for (let i = 0; i < lives; i++) {
    const cx = 14 + i * 16;
    const cy = 18;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-Math.PI / 2); // point up
    ctx.beginPath();
    ctx.moveTo(5, 0);
    ctx.lineTo(-3.5, -3);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-3.5, 3);
    ctx.closePath();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}

function drawPixelText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, align: CanvasTextAlign = "center") {
  ctx.font = `bold ${size}px monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  // shadow
  ctx.fillStyle = "#000000";
  ctx.fillText(text, x + 1, y + 1);
  // text
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x, y);
}

/* ---- Component ---- */

export default function AsteroidsGame({ onAddHighscore, paused = false }: AsteroidsGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);

  const [containerSize, setContainerSize] = useState({ w: 400, h: 400 });
  const [phase, setPhase] = useState<GamePhase>("idle");
  const [displayScore, setDisplayScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [displayWave, setDisplayWave] = useState(1);
  const [displayLives, setDisplayLives] = useState(3);
  const [showResults, setShowResults] = useState(false);
  const [asteroidsDestroyed, setAsteroidsDestroyed] = useState(0);

  const phaseRef = useRef<GamePhase>("idle");
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Game state refs
  const shipRef = useRef<Ship>({ pos: { x: W / 2, y: H / 2 }, vel: { x: 0, y: 0 }, angle: -Math.PI / 2, thrusting: false });
  const bulletsRef = useRef<Bullet[]>([]);
  const asteroidsRef = useRef<Asteroid[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const starsRef = useRef<Star[]>([]);

  const scoreRef = useRef(0);
  const bestRef = useRef(0);
  const livesRef = useRef(3);
  const waveRef = useRef(1);
  const invulnRef = useRef(0);
  const destroyedRef = useRef(0);
  const nextBonusRef = useRef(BONUS_LIFE_SCORE);

  // Wave transition
  const waveDelayRef = useRef(0);
  const waveFlashRef = useRef(0);

  // Death animation
  const deathTimerRef = useRef(0);
  const flashFramesRef = useRef(0);

  // Input
  const keysRef = useRef<Set<string>>(new Set());

  // Loop timing
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const accumRef = useRef(0);

  // Idle animation
  const idleAngleRef = useRef(0);

  // Initialize stars once
  if (starsRef.current.length === 0) {
    starsRef.current = genStars(80);
  }

  // CSS canvas sizing (1:1 aspect)
  const aspect = 1;
  const cAspect = containerSize.w / containerSize.h;
  const cssW = cAspect > aspect ? Math.floor(containerSize.h * aspect) : containerSize.w;
  const cssH = cAspect > aspect ? containerSize.h : Math.floor(containerSize.w / aspect);

  // Resize observer
  useEffect(() => {
    const area = canvasAreaRef.current;
    if (!area) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        if (width > 0 && height > 0) setContainerSize({ w: Math.floor(width), h: Math.floor(height) });
      }
    });
    ro.observe(area);
    return () => ro.disconnect();
  }, []);

  // Set canvas native size
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = W;
    c.height = H;
  }, []);

  const spawnExplosion = useCallback((pos: Vec2, count: number, speed: number) => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = speed * (0.5 + Math.random());
      const life = 15 + Math.floor(Math.random() * 20);
      particlesRef.current.push({
        pos: { x: pos.x, y: pos.y },
        vel: { x: Math.cos(angle) * spd, y: Math.sin(angle) * spd },
        life,
        maxLife: life,
      });
    }
  }, []);

  const initGame = useCallback(() => {
    shipRef.current = {
      pos: { x: W / 2, y: H / 2 },
      vel: { x: 0, y: 0 },
      angle: -Math.PI / 2,
      thrusting: false,
    };
    bulletsRef.current = [];
    particlesRef.current = [];
    scoreRef.current = 0;
    livesRef.current = 3;
    waveRef.current = 1;
    invulnRef.current = INVULN_FRAMES;
    destroyedRef.current = 0;
    nextBonusRef.current = BONUS_LIFE_SCORE;
    waveDelayRef.current = 0;
    waveFlashRef.current = 0;
    deathTimerRef.current = 0;
    flashFramesRef.current = 0;
    accumRef.current = 0;
    lastTimeRef.current = 0;

    asteroidsRef.current = spawnWaveAsteroids(1, shipRef.current.pos);

    setDisplayScore(0);
    setDisplayWave(1);
    setDisplayLives(3);
    setAsteroidsDestroyed(0);
    setShowResults(false);
    setPhase("playing");
    phaseRef.current = "playing";
  }, []);

  const startDying = useCallback(() => {
    if (phaseRef.current === "dying") return;
    phaseRef.current = "dying";
    setPhase("dying");
    flashFramesRef.current = 6;
    deathTimerRef.current = 0;
    lastTimeRef.current = 0;
    accumRef.current = 0;

    // Spawn ship explosion
    spawnExplosion(shipRef.current.pos, 16, 3);
  }, [spawnExplosion]);

  const finishDeath = useCallback(() => {
    phaseRef.current = "over";
    setPhase("over");
    const s = scoreRef.current;
    if (s > 0) onAddHighscore(s);
    if (s > bestRef.current) { bestRef.current = s; setBestScore(s); }
  }, [onAddHighscore]);

  const shootBullet = useCallback(() => {
    if (bulletsRef.current.length >= MAX_BULLETS) return;
    const ship = shipRef.current;
    bulletsRef.current.push({
      pos: {
        x: ship.pos.x + Math.cos(ship.angle) * SHIP_RADIUS,
        y: ship.pos.y + Math.sin(ship.angle) * SHIP_RADIUS,
      },
      vel: {
        x: Math.cos(ship.angle) * BULLET_SPEED + ship.vel.x * 0.3,
        y: Math.sin(ship.angle) * BULLET_SPEED + ship.vel.y * 0.3,
      },
      life: BULLET_LIFE,
    });
  }, []);

  const handleAction = useCallback(() => {
    if (phaseRef.current === "idle") { initGame(); return; }
    if (phaseRef.current === "over") { initGame(); return; }
    if (phaseRef.current === "dying") return;
  }, [initGame]);

  // Keyboard listeners on container ref
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onDown = (e: KeyboardEvent) => {
      const key = e.code;

      // Prevent scrolling
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(key)) {
        e.preventDefault();
        e.stopPropagation();
      }

      if (key === "Space") {
        if (phaseRef.current === "idle" || phaseRef.current === "over") {
          handleAction();
          return;
        }
        if (phaseRef.current === "playing" && !pausedRef.current) {
          shootBullet();
        }
        return;
      }

      keysRef.current.add(key);
    };

    const onUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.code);
    };

    el.addEventListener("keydown", onDown);
    el.addEventListener("keyup", onUp);
    return () => {
      el.removeEventListener("keydown", onDown);
      el.removeEventListener("keyup", onUp);
    };
  }, [handleAction, shootBullet]);

  // Focus container when phase changes
  useEffect(() => { containerRef.current?.focus(); }, [phase]);

  /* ---- Draw ---- */
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    // Clear to black
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, W, H);

    // Stars
    for (const star of starsRef.current) {
      ctx.fillStyle = `rgba(255,255,255,${star.brightness})`;
      ctx.fillRect(Math.floor(star.x), Math.floor(star.y), 1, 1);
    }

    // Asteroids
    for (const ast of asteroidsRef.current) {
      drawAsteroid(ctx, ast);
    }

    // Bullets
    for (const b of bulletsRef.current) {
      drawBullet(ctx, b);
    }

    // Particles
    for (const p of particlesRef.current) {
      drawParticle(ctx, p);
    }

    // Ship (only in playing/idle, not dying/over)
    if (phaseRef.current === "playing" || phaseRef.current === "idle") {
      const blink = invulnRef.current > 0 && Math.floor(invulnRef.current / 3) % 2 === 1;
      drawShip(ctx, shipRef.current, blink);
    }

    // Lives display
    if (phaseRef.current === "playing" || phaseRef.current === "dying") {
      drawLives(ctx, livesRef.current);
    }

    // Score
    if (phaseRef.current !== "idle") {
      drawPixelText(ctx, String(scoreRef.current), W / 2, 8, 16);
    }

    // Wave flash text
    if (waveFlashRef.current > 0) {
      const alpha = Math.min(waveFlashRef.current / 15, 1);
      ctx.globalAlpha = alpha;
      drawPixelText(ctx, `WAVE ${waveRef.current}`, W / 2, H / 2 - 12, 20);
      ctx.globalAlpha = 1;
    }

    // Death flash overlay
    if (flashFramesRef.current > 0) {
      ctx.fillStyle = "#ffffff";
      ctx.globalAlpha = (flashFramesRef.current / 6) * 0.7;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  };

  /* ---- Game step ---- */
  const stepRef = useRef<() => void>(() => {});
  stepRef.current = () => {
    const ship = shipRef.current;
    const keys = keysRef.current;

    // Wave delay (between waves)
    if (waveDelayRef.current > 0) {
      waveDelayRef.current--;
      if (waveDelayRef.current === 0) {
        waveRef.current++;
        setDisplayWave(waveRef.current);
        asteroidsRef.current = spawnWaveAsteroids(waveRef.current, ship.pos);
        waveFlashRef.current = 45; // flash "WAVE X" for 1.5s
      }
    }

    if (waveFlashRef.current > 0) waveFlashRef.current--;

    // Ship rotation
    if (keys.has("ArrowLeft") || keys.has("KeyA")) {
      ship.angle -= ROTATE_SPEED;
    }
    if (keys.has("ArrowRight") || keys.has("KeyD")) {
      ship.angle += ROTATE_SPEED;
    }

    // Thrust
    ship.thrusting = keys.has("ArrowUp") || keys.has("KeyW");
    if (ship.thrusting) {
      ship.vel.x += Math.cos(ship.angle) * THRUST_ACCEL;
      ship.vel.y += Math.sin(ship.angle) * THRUST_ACCEL;
    }

    // Friction
    ship.vel.x *= FRICTION;
    ship.vel.y *= FRICTION;

    // Speed cap
    const spd = Math.sqrt(ship.vel.x * ship.vel.x + ship.vel.y * ship.vel.y);
    if (spd > MAX_SPEED) {
      ship.vel.x = (ship.vel.x / spd) * MAX_SPEED;
      ship.vel.y = (ship.vel.y / spd) * MAX_SPEED;
    }

    // Move ship
    ship.pos.x += ship.vel.x;
    ship.pos.y += ship.vel.y;
    ship.pos = wrap(ship.pos);

    // Invulnerability countdown
    if (invulnRef.current > 0) invulnRef.current--;

    // Update bullets
    for (const b of bulletsRef.current) {
      b.pos.x += b.vel.x;
      b.pos.y += b.vel.y;
      b.pos = wrap(b.pos);
      b.life--;
    }
    bulletsRef.current = bulletsRef.current.filter((b) => b.life > 0);

    // Update asteroids
    for (const a of asteroidsRef.current) {
      a.pos.x += a.vel.x;
      a.pos.y += a.vel.y;
      a.pos = wrap(a.pos);
      a.rotation += a.rotSpeed;
    }

    // Update particles
    for (const p of particlesRef.current) {
      p.pos.x += p.vel.x;
      p.pos.y += p.vel.y;
      p.vel.x *= 0.96;
      p.vel.y *= 0.96;
      p.life--;
    }
    particlesRef.current = particlesRef.current.filter((p) => p.life > 0);

    // Bullet-asteroid collisions
    const newAsteroids: Asteroid[] = [];
    const bulletsToRemove = new Set<number>();

    for (let bi = 0; bi < bulletsRef.current.length; bi++) {
      const b = bulletsRef.current[bi];
      for (let ai = asteroidsRef.current.length - 1; ai >= 0; ai--) {
        const a = asteroidsRef.current[ai];
        const info = ASTEROID_SIZES[a.size];
        if (dist(b.pos, a.pos) < info.radius) {
          bulletsToRemove.add(bi);

          // Score
          scoreRef.current += info.points;
          setDisplayScore(scoreRef.current);
          destroyedRef.current++;
          setAsteroidsDestroyed(destroyedRef.current);

          // Bonus life
          if (scoreRef.current >= nextBonusRef.current) {
            livesRef.current++;
            setDisplayLives(livesRef.current);
            nextBonusRef.current += BONUS_LIFE_SCORE;
          }

          // Explosion particles
          spawnExplosion(a.pos, 8 + Math.floor(Math.random() * 5), 2);

          // Split asteroid
          if (info.splits > 0) {
            for (let s = 0; s < info.splits; s++) {
              const splitAngle = Math.random() * Math.PI * 2;
              const splitSpeed = 0.8 + Math.random() * 1.2;
              newAsteroids.push(spawnAsteroid(info.childSize, { ...a.pos }, {
                x: Math.cos(splitAngle) * splitSpeed,
                y: Math.sin(splitAngle) * splitSpeed,
              }));
            }
          }

          // Remove this asteroid
          asteroidsRef.current.splice(ai, 1);
          break;
        }
      }
    }

    bulletsRef.current = bulletsRef.current.filter((_, i) => !bulletsToRemove.has(i));
    asteroidsRef.current.push(...newAsteroids);

    // Ship-asteroid collision (only if not invulnerable)
    if (invulnRef.current <= 0) {
      for (const a of asteroidsRef.current) {
        const info = ASTEROID_SIZES[a.size];
        if (dist(ship.pos, a.pos) < info.radius + SHIP_RADIUS * 0.6) {
          // Ship hit!
          livesRef.current--;
          setDisplayLives(livesRef.current);

          if (livesRef.current <= 0) {
            startDying();
            return;
          } else {
            // Respawn with invulnerability
            spawnExplosion(ship.pos, 12, 2.5);
            ship.pos = { x: W / 2, y: H / 2 };
            ship.vel = { x: 0, y: 0 };
            ship.angle = -Math.PI / 2;
            ship.thrusting = false;
            bulletsRef.current = [];
            invulnRef.current = INVULN_FRAMES;
            return;
          }
        }
      }
    }

    // Wave clear check
    if (asteroidsRef.current.length === 0 && waveDelayRef.current === 0) {
      waveDelayRef.current = WAVE_DELAY_FRAMES;
    }
  };

  /* ---- Playing game loop ---- */
  useEffect(() => {
    if (phaseRef.current !== "playing") return;

    const loop = (time: number) => {
      if (phaseRef.current !== "playing") return;

      if (pausedRef.current) {
        lastTimeRef.current = 0;
        accumRef.current = 0;
        rafRef.current = requestAnimationFrame(loop);
        drawRef.current();
        return;
      }

      if (lastTimeRef.current === 0) {
        lastTimeRef.current = time;
        rafRef.current = requestAnimationFrame(loop);
        drawRef.current();
        return;
      }

      const elapsed = Math.min(time - lastTimeRef.current, 100);
      lastTimeRef.current = time;
      accumRef.current += elapsed;

      while (accumRef.current >= FRAME_MS) {
        accumRef.current -= FRAME_MS;
        stepRef.current();
        if (phaseRef.current !== "playing") {
          drawRef.current();
          return;
        }
      }

      drawRef.current();
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase]);

  /* ---- Dying animation loop ---- */
  useEffect(() => {
    if (phaseRef.current !== "dying") return;

    const deathLoop = (time: number) => {
      if (phaseRef.current !== "dying") return;

      if (lastTimeRef.current === 0) {
        lastTimeRef.current = time;
        rafRef.current = requestAnimationFrame(deathLoop);
        drawRef.current();
        return;
      }

      const elapsed = Math.min(time - lastTimeRef.current, 100);
      lastTimeRef.current = time;
      accumRef.current += elapsed;

      while (accumRef.current >= FRAME_MS) {
        accumRef.current -= FRAME_MS;

        if (flashFramesRef.current > 0) flashFramesRef.current--;

        // Update particles during death
        for (const p of particlesRef.current) {
          p.pos.x += p.vel.x;
          p.pos.y += p.vel.y;
          p.vel.x *= 0.96;
          p.vel.y *= 0.96;
          p.life--;
        }
        particlesRef.current = particlesRef.current.filter((p) => p.life > 0);

        // Update asteroids (they keep drifting)
        for (const a of asteroidsRef.current) {
          a.pos.x += a.vel.x;
          a.pos.y += a.vel.y;
          a.pos = wrap(a.pos);
          a.rotation += a.rotSpeed;
        }

        deathTimerRef.current++;
        if (deathTimerRef.current >= 60) {
          finishDeath();
          drawRef.current();
          return;
        }
      }

      drawRef.current();
      rafRef.current = requestAnimationFrame(deathLoop);
    };

    rafRef.current = requestAnimationFrame(deathLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, finishDeath]);

  /* ---- Idle animation loop ---- */
  useEffect(() => {
    if (phaseRef.current !== "idle") return;

    // Spawn some demo asteroids for idle screen
    if (asteroidsRef.current.length === 0) {
      const center = { x: W / 2, y: H / 2 };
      asteroidsRef.current = spawnWaveAsteroids(1, center);
    }
    shipRef.current = {
      pos: { x: W / 2, y: H / 2 },
      vel: { x: 0, y: 0 },
      angle: -Math.PI / 2,
      thrusting: false,
    };

    const idleLoop = (_time: number) => {
      if (phaseRef.current !== "idle") return;

      // Slowly rotate ship
      idleAngleRef.current += 0.02;
      shipRef.current.angle = idleAngleRef.current;

      // Drift asteroids
      for (const a of asteroidsRef.current) {
        a.pos.x += a.vel.x;
        a.pos.y += a.vel.y;
        a.pos = wrap(a.pos);
        a.rotation += a.rotSpeed;
      }

      drawRef.current();
      rafRef.current = requestAnimationFrame(idleLoop);
    };

    rafRef.current = requestAnimationFrame(idleLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase]);

  // Draw once for over phase
  useEffect(() => {
    if (phaseRef.current === "over" || phaseRef.current === "dying") drawRef.current();
  }, [phase]);

  // Show results panel with slight delay
  useEffect(() => {
    if (phase === "over") {
      const timer = setTimeout(() => setShowResults(true), 50);
      return () => clearTimeout(timer);
    }
    setShowResults(false);
  }, [phase]);

  const handleCanvasClick = useCallback(() => handleAction(), [handleAction]);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      style={{
        width: "100%", height: "100%", position: "relative", outline: "none",
        display: "flex", flexDirection: "column", backgroundColor: "#000",
      }}
    >
      {/* Score bar */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "6px 12px", fontSize: 12, fontWeight: 600,
        color: "var(--ezy-text-secondary)", borderBottom: "1px solid var(--ezy-border)",
        fontVariantNumeric: "tabular-nums",
        fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)",
      }}>
        <span>Score: <span style={{ color: "var(--ezy-accent)" }}>{displayScore}</span></span>
        <span style={{ fontSize: 10, color: "var(--ezy-text-muted)", fontFamily: "monospace" }}>
          {phase === "idle" ? "Arrow keys + Space" : `Wave ${displayWave} | Lives ${displayLives}`}
        </span>
        {bestScore > 0 && <span>Best: {bestScore}</span>}
      </div>

      {/* Canvas area */}
      <div
        ref={canvasAreaRef}
        data-canvas-area
        style={{
          flex: 1, position: "relative", overflow: "hidden",
          display: "flex", alignItems: "center", justifyContent: "center",
          backgroundColor: "#000",
        }}
      >
        <canvas
          ref={canvasRef}
          onClick={handleCanvasClick}
          style={{
            display: "block", cursor: "pointer",
            width: cssW, height: cssH,
            imageRendering: "pixelated",
          }}
        />

        {/* Idle overlay */}
        {phase === "idle" && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.45)", gap: 16,
          }}>
            <div style={{
              fontSize: 24, fontWeight: 700, color: "#fff",
              fontFamily: "monospace", textShadow: "3px 3px 0 #000",
              letterSpacing: 2, textTransform: "uppercase",
            }}>
              Asteroids
            </div>
            <div onClick={initGame} style={{
              padding: "8px 24px", fontSize: 14, fontWeight: 700,
              color: "#0a0a18", backgroundColor: "#5eead4",
              borderRadius: 2, cursor: "pointer", userSelect: "none",
              fontFamily: "monospace", textTransform: "uppercase",
              border: "2px solid #3ac0a8",
            }}>
              Start Game
            </div>
            <div style={{ fontSize: 11, color: "#888", fontFamily: "monospace", textTransform: "uppercase" }}>
              Arrows to steer / Up to thrust / Space to shoot
            </div>
          </div>
        )}

        {/* Game over overlay */}
        {phase === "over" && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            backgroundColor: showResults ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0)",
            transition: "background-color 0.4s ease",
            pointerEvents: showResults ? "auto" : "none",
          }}>
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
              transform: showResults ? "translateY(0)" : "translateY(60px)",
              opacity: showResults ? 1 : 0,
              transition: "transform 0.45s cubic-bezier(0.2, 0.8, 0.3, 1), opacity 0.35s ease",
            }}>
              <div style={{
                fontSize: 24, fontWeight: 700, color: "#fff",
                fontFamily: "monospace", textShadow: "3px 3px 0 #000",
                letterSpacing: 2, textTransform: "uppercase",
              }}>
                Game Over
              </div>

              {/* Results card */}
              <div style={{
                backgroundColor: "rgba(10,10,24,0.85)",
                border: "2px solid #333",
                borderRadius: 4,
                padding: "12px 24px",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                minWidth: 160,
              }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#888", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: 1 }}>
                  Score
                </div>
                <div style={{
                  fontSize: 36, fontWeight: 700, color: "#5eead4",
                  fontFamily: "monospace", fontVariantNumeric: "tabular-nums",
                  lineHeight: 1,
                }}>
                  {displayScore}
                </div>
                {displayScore > 0 && displayScore >= bestScore && (
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#4ade80", fontFamily: "monospace" }}>
                    NEW BEST!
                  </div>
                )}
                {bestScore > 0 && (
                  <div style={{ fontSize: 11, color: "#666", fontFamily: "monospace" }}>
                    Best: {bestScore}
                  </div>
                )}

                {/* Stats */}
                <div style={{
                  display: "flex", gap: 16, marginTop: 4,
                  fontSize: 11, fontFamily: "monospace", color: "#aaa",
                }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <span style={{ color: "#666", textTransform: "uppercase", fontSize: 9 }}>Destroyed</span>
                    <span style={{ color: "#fff", fontWeight: 700 }}>{asteroidsDestroyed}</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <span style={{ color: "#666", textTransform: "uppercase", fontSize: 9 }}>Wave</span>
                    <span style={{ color: "#fff", fontWeight: 700 }}>{displayWave}</span>
                  </div>
                </div>
              </div>

              <div onClick={initGame} style={{
                padding: "8px 24px", fontSize: 14, fontWeight: 700,
                color: "#0a0a18", backgroundColor: "#5eead4",
                borderRadius: 2, cursor: "pointer", userSelect: "none",
                fontFamily: "monospace", textTransform: "uppercase",
                border: "2px solid #3ac0a8", marginTop: 4,
              }}>
                Play Again
              </div>
              <div style={{ fontSize: 11, color: "#888", fontFamily: "monospace", textTransform: "uppercase" }}>
                Space to retry
              </div>
            </div>
          </div>
        )}

        {/* Pause overlay */}
        {paused && phase === "playing" && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.6)",
          }}>
            <div style={{
              fontSize: 22, fontWeight: 700, color: "#fff",
              fontFamily: "monospace", textShadow: "3px 3px 0 #000",
              textTransform: "uppercase", letterSpacing: 2,
            }}>
              Paused
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

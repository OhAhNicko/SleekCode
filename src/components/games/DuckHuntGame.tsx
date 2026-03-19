import { useRef, useEffect, useState, useCallback } from "react";

interface DuckHuntGameProps {
  onAddHighscore: (score: number) => void;
  paused?: boolean;
}

type GamePhase = "idle" | "playing" | "dying" | "over";

/* ---- NES Duck Hunt canvas (256x240 native resolution @ 30fps) ---- */
const W = 256;
const H = 240;
const FRAME_MS = 1000 / 30;

/* ---- Layout constants ---- */
const TREE_LINE_Y = 148;
const GRASS_Y = 184;
const HUD_Y = 200;

/* ---- Duck constants ---- */
const DUCK_W = 16;
const DUCK_H = 16;
const DUCK_SPEED_BASE = 3.2;
const DUCKS_PER_ROUND = 10;

/* ---- Difficulty scaling helpers ---- */
/** Duck flight speed for the given round */
function duckSpeed(round: number): number {
  // Base 3.2, +0.5 per round, accelerates further after round 3
  return DUCK_SPEED_BASE + round * 0.5 + (round > 3 ? (round - 3) * 0.3 : 0);
}

/** Escape timer (frames) — ducks fly away sooner in later rounds */
function escapeFrames(round: number): number {
  // Round 1 ~3s (90f), shrinks aggressively to ~1.7s minimum (50f)
  return Math.max(50, 90 - (round - 1) * 10);
}

/** Chance per frame of a random direction jink (higher = more erratic) */
function jinkChance(round: number): number {
  // Round 1: 7%, scales up to ~18% by round 6+
  return Math.min(0.18, 0.07 + round * 0.02);
}

/** Jink magnitude multiplier — sharper turns in later rounds */
function jinkMag(round: number): number {
  return 1.2 + round * 0.2;
}

/** How many ducks spawn simultaneously this wave */
function ducksPerWave(round: number, duckIndex: number): number {
  // From round 3 onward, every 3rd wave spawns 2 ducks
  // From round 6 onward, every other wave spawns 2 ducks
  if (round >= 6 && duckIndex % 2 === 0) return 2;
  if (round >= 3 && duckIndex % 3 === 0) return 2;
  return 1;
}

/** Delay (frames) between ducks — shorter in later rounds */
function betweenDuckDelay(round: number): number {
  return Math.max(15, 35 - (round - 1) * 4);
}

/** Delay (frames) between rounds */
function betweenRoundDelay(round: number): number {
  return Math.max(25, 45 - (round - 1) * 4);
}

/* ---- Scoring ---- */
const BASE_SCORE = 500;
const PERFECT_BONUS = 10000;
const SHOTS_PER_DUCK = 3;

/* ---- Dog animation constants ---- */
const DOG_W = 24;
const DOG_X = W / 2 - DOG_W / 2;
const DOG_GROUND_Y = GRASS_Y - 8;

/* ---- Colors ---- */
const C = {
  text: "#ffffff",
  textSh: "#000000",
  // Sky themes per round group
  skyDay1: "#6888ff",
  skyDay2: "#88b0ff",
  skySunset1: "#c85820",
  skySunset2: "#e8a030",
  skyDusk1: "#382858",
  skyDusk2: "#684888",
  skyNight1: "#080820",
  skyNight2: "#182048",
  // Scenery
  treeDark: "#0a4a0a",
  treeMid: "#186818",
  treeLight: "#208820",
  grassDark: "#30a830",
  grassLight: "#58c858",
  grassEdge: "#208020",
  // Duck colors
  duckGreen: "#38a838",
  duckBrown: "#885830",
  duckWhite: "#e8e8e8",
  duckWing: "#284828",
  duckBeak: "#e8a030",
  duckEye: "#ffffff",
  duckEyePupil: "#181818",
  // Dog
  dogBrown: "#a86830",
  dogLight: "#c88848",
  dogDark: "#784820",
  dogNose: "#181818",
  dogEyeW: "#ffffff",
  dogEyeB: "#181818",
  dogMouth: "#c03030",
  // HUD
  hudBg: "#000000",
  hudGreen: "#30a830",
  hudRed: "#d03030",
  hudWhite: "#ffffff",
  bulletColor: "#c8c8c8",
  // Hit effect
  hitWhite: "#ffffff",
};

/* ---- Sky theme per round ---- */
function getSkyColors(round: number): [string, string] {
  if (round <= 2) return [C.skyDay1, C.skyDay2];
  if (round <= 4) return [C.skySunset1, C.skySunset2];
  if (round <= 6) return [C.skyDusk1, C.skyDusk2];
  return [C.skyNight1, C.skyNight2];
}

/* ---- Minimum ducks to hit per round ---- */
function minHitsForRound(round: number): number {
  // Round 1: 7/10, round 3+: 9/10
  return Math.min(7 + round - 1, 9);
}

/* ---- Interfaces ---- */
interface Duck {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alive: boolean;
  escaping: boolean;
  escaped: boolean;
  hit: boolean;
  falling: boolean;
  fallVY: number;
  frameTimer: number;
  wingFrame: number; // 0 or 1
  lifeFrames: number;
  facingRight: boolean;
  spinAngle: number;
}

interface HitParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

type DogState = "hidden" | "sniffing" | "jumping" | "holding" | "laughing";

/* ---- Tree silhouette generation ---- */
function genTreeLine(): number[] {
  const heights: number[] = [];
  for (let x = 0; x < W; x++) {
    // Semi-random tree line with bumps
    const base = TREE_LINE_Y;
    const h = base - 16 - Math.floor(
      Math.sin(x * 0.08) * 8 +
      Math.sin(x * 0.2) * 4 +
      Math.sin(x * 0.35 + 2) * 6 +
      Math.cos(x * 0.05 + 1) * 10
    );
    heights.push(h);
  }
  return heights;
}

/* ---- Draw functions ---- */

function drawSky(ctx: CanvasRenderingContext2D, round: number) {
  const [c1, c2] = getSkyColors(round);
  const grad = ctx.createLinearGradient(0, 0, 0, GRASS_Y);
  grad.addColorStop(0, c1);
  grad.addColorStop(1, c2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, GRASS_Y);
}

function drawStars(ctx: CanvasRenderingContext2D, round: number, stars: [number, number][]) {
  if (round < 5) return;
  const alpha = round >= 7 ? 0.9 : 0.4;
  ctx.fillStyle = C.text;
  ctx.globalAlpha = alpha;
  for (const [sx, sy] of stars) {
    ctx.fillRect(sx, sy, 1, 1);
  }
  ctx.globalAlpha = 1;
}

function drawTreeLine(ctx: CanvasRenderingContext2D, treeHeights: number[]) {
  // Dark tree silhouette
  ctx.fillStyle = C.treeDark;
  for (let x = 0; x < W; x++) {
    ctx.fillRect(x, treeHeights[x], 1, GRASS_Y - treeHeights[x]);
  }
  // Mid highlights on tree tops
  ctx.fillStyle = C.treeMid;
  for (let x = 0; x < W; x += 3) {
    ctx.fillRect(x, treeHeights[x], 2, 3);
  }
  // Light edge on some trees
  ctx.fillStyle = C.treeLight;
  for (let x = 4; x < W; x += 8) {
    ctx.fillRect(x, treeHeights[x], 1, 2);
  }
}

function drawGrass(ctx: CanvasRenderingContext2D) {
  // Main grass area
  ctx.fillStyle = C.grassDark;
  ctx.fillRect(0, GRASS_Y, W, HUD_Y - GRASS_Y);
  // Light grass stripe
  ctx.fillStyle = C.grassLight;
  ctx.fillRect(0, GRASS_Y, W, 3);
  // Edge line
  ctx.fillStyle = C.grassEdge;
  ctx.fillRect(0, GRASS_Y - 1, W, 1);
  // Grass tufts
  ctx.fillStyle = C.grassLight;
  for (let x = 2; x < W; x += 10) {
    ctx.fillRect(x, GRASS_Y + 4, 3, 2);
    ctx.fillRect(x + 5, GRASS_Y + 8, 2, 2);
  }
}

function drawHUD(
  ctx: CanvasRenderingContext2D,
  round: number,
  score: number,
  shotsLeft: number,
  ducksHit: boolean[],
) {
  // HUD background
  ctx.fillStyle = C.hudBg;
  ctx.fillRect(0, HUD_Y, W, H - HUD_Y);

  // Top border
  ctx.fillStyle = "#333333";
  ctx.fillRect(0, HUD_Y, W, 1);

  // Round number (left)
  ctx.font = "bold 9px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = C.hudWhite;
  ctx.fillText(`R${round}`, 4, HUD_Y + 4);

  // Score (right)
  ctx.textAlign = "right";
  ctx.fillText(String(score).padStart(6, "0"), W - 4, HUD_Y + 4);

  // Shots remaining (center-left, bullet icons)
  const bulletStartX = 30;
  const bulletY = HUD_Y + 5;
  for (let i = 0; i < SHOTS_PER_DUCK; i++) {
    if (i < shotsLeft) {
      // Filled bullet
      ctx.fillStyle = C.bulletColor;
      ctx.fillRect(bulletStartX + i * 8, bulletY, 3, 7);
      ctx.fillRect(bulletStartX + i * 8 - 1, bulletY + 1, 5, 5);
      ctx.fillStyle = "#e8b830";
      ctx.fillRect(bulletStartX + i * 8, bulletY + 5, 3, 2);
    } else {
      // Empty bullet slot
      ctx.fillStyle = "#333333";
      ctx.fillRect(bulletStartX + i * 8, bulletY, 3, 7);
    }
  }

  // Duck hit/miss tracker (bottom row)
  const trackerStartX = Math.floor(W / 2 - (DUCKS_PER_ROUND * 8) / 2);
  const trackerY = HUD_Y + 18;
  ctx.font = "7px monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = "#555555";
  ctx.fillText("HIT", trackerStartX - 18, trackerY + 1);

  for (let i = 0; i < DUCKS_PER_ROUND; i++) {
    if (i < ducksHit.length) {
      ctx.fillStyle = ducksHit[i] ? C.hudGreen : C.hudRed;
    } else {
      ctx.fillStyle = "#222222";
    }
    // Small duck silhouette
    ctx.fillRect(trackerStartX + i * 8, trackerY, 6, 5);
    ctx.fillRect(trackerStartX + i * 8 + 1, trackerY - 1, 4, 1);
    ctx.fillRect(trackerStartX + i * 8 + 4, trackerY + 1, 2, 2);
  }

  // Min hits indicator
  const minHits = minHitsForRound(round);
  ctx.fillStyle = "#555555";
  ctx.font = "7px monospace";
  ctx.textAlign = "right";
  ctx.fillText(`${minHits}/${DUCKS_PER_ROUND}`, W - 4, trackerY + 1);
}

function drawDuck(ctx: CanvasRenderingContext2D, duck: Duck) {
  const dx = Math.floor(duck.x - DUCK_W / 2);
  const dy = Math.floor(duck.y - DUCK_H / 2);

  ctx.save();

  if (duck.falling) {
    // Spinning fall animation
    ctx.translate(duck.x, duck.y);
    ctx.rotate(duck.spinAngle);
    ctx.translate(-duck.x, -duck.y);
  }

  if (!duck.facingRight) {
    ctx.translate(duck.x, 0);
    ctx.scale(-1, 1);
    ctx.translate(-duck.x, 0);
  }

  // Body (green head, brown body)
  ctx.fillStyle = C.duckGreen;
  // Head
  ctx.fillRect(dx + 8, dy + 1, 7, 7);
  ctx.fillRect(dx + 7, dy + 2, 9, 5);
  // Neck
  ctx.fillRect(dx + 6, dy + 6, 5, 3);

  // Body (brown)
  ctx.fillStyle = C.duckBrown;
  ctx.fillRect(dx + 2, dy + 6, 10, 7);
  ctx.fillRect(dx + 1, dy + 7, 12, 5);
  ctx.fillRect(dx + 3, dy + 5, 6, 2);

  // White belly/collar
  ctx.fillStyle = C.duckWhite;
  ctx.fillRect(dx + 7, dy + 5, 4, 2);
  ctx.fillRect(dx + 3, dy + 11, 8, 2);

  // Wing (animated)
  ctx.fillStyle = C.duckWing;
  if (duck.wingFrame === 0) {
    // Wings up
    ctx.fillRect(dx + 2, dy + 3, 6, 3);
    ctx.fillRect(dx + 1, dy + 4, 7, 2);
    ctx.fillRect(dx, dy + 2, 4, 2);
  } else {
    // Wings down
    ctx.fillRect(dx + 2, dy + 9, 6, 3);
    ctx.fillRect(dx + 1, dy + 10, 7, 2);
    ctx.fillRect(dx, dy + 12, 4, 2);
  }

  // Eye
  ctx.fillStyle = C.duckEye;
  ctx.fillRect(dx + 12, dy + 2, 3, 3);
  ctx.fillStyle = C.duckEyePupil;
  ctx.fillRect(dx + 13, dy + 3, 2, 2);

  // Beak
  ctx.fillStyle = C.duckBeak;
  ctx.fillRect(dx + 14, dy + 5, 3, 2);
  ctx.fillRect(dx + 15, dy + 4, 2, 1);

  ctx.restore();
}

function drawDog(
  ctx: CanvasRenderingContext2D,
  state: DogState,
  dogX: number,
  dogY: number,
  animFrame: number,
) {
  if (state === "hidden") return;

  const dx = Math.floor(dogX);
  const dy = Math.floor(dogY);

  ctx.save();

  if (state === "sniffing") {
    // Dog walking/sniffing along grass - only head visible above grass
    const bobY = Math.sin(animFrame * 0.3) * 2;
    const sx = dx;
    const sy = dy + Math.floor(bobY);

    // Body (partially hidden by grass)
    ctx.fillStyle = C.dogBrown;
    ctx.fillRect(sx, sy + 8, 20, 12);
    ctx.fillRect(sx + 2, sy + 6, 16, 4);
    // Head
    ctx.fillStyle = C.dogLight;
    ctx.fillRect(sx + 14, sy, 10, 10);
    ctx.fillRect(sx + 12, sy + 2, 14, 6);
    // Ears
    ctx.fillStyle = C.dogDark;
    ctx.fillRect(sx + 22, sy - 2, 4, 6);
    ctx.fillRect(sx + 14, sy - 1, 3, 4);
    // Nose
    ctx.fillStyle = C.dogNose;
    ctx.fillRect(sx + 24, sy + 4, 3, 3);
    // Eye
    ctx.fillStyle = C.dogEyeW;
    ctx.fillRect(sx + 18, sy + 2, 3, 3);
    ctx.fillStyle = C.dogEyeB;
    ctx.fillRect(sx + 19, sy + 3, 2, 2);
    // Sniff dots
    if (animFrame % 12 < 6) {
      ctx.fillStyle = C.text;
      ctx.globalAlpha = 0.6;
      ctx.fillRect(sx + 28, sy + 3, 1, 1);
      ctx.fillRect(sx + 30, sy + 1, 1, 1);
      ctx.globalAlpha = 1;
    }
  } else if (state === "jumping") {
    // Dog jumps up briefly
    const sy = dy - 10;
    ctx.fillStyle = C.dogBrown;
    ctx.fillRect(dx + 2, sy + 6, 16, 14);
    ctx.fillStyle = C.dogLight;
    ctx.fillRect(dx + 10, sy, 10, 10);
    ctx.fillRect(dx + 8, sy + 2, 14, 6);
    // Ears
    ctx.fillStyle = C.dogDark;
    ctx.fillRect(dx + 18, sy - 4, 4, 6);
    // Eye
    ctx.fillStyle = C.dogEyeW;
    ctx.fillRect(dx + 14, sy + 2, 3, 3);
    ctx.fillStyle = C.dogEyeB;
    ctx.fillRect(dx + 15, sy + 3, 2, 2);
  } else if (state === "holding") {
    // Dog pops up holding duck, happy face
    ctx.fillStyle = C.dogBrown;
    ctx.fillRect(dx + 2, dy + 4, 16, 14);
    ctx.fillStyle = C.dogLight;
    ctx.fillRect(dx + 10, dy - 4, 10, 10);
    ctx.fillRect(dx + 8, dy - 2, 14, 6);
    // Happy mouth
    ctx.fillStyle = C.dogMouth;
    ctx.fillRect(dx + 14, dy + 4, 6, 2);
    ctx.fillRect(dx + 15, dy + 3, 4, 1);
    // Eye - happy squint
    ctx.fillStyle = C.dogEyeB;
    ctx.fillRect(dx + 12, dy, 4, 1);
    ctx.fillRect(dx + 12, dy - 1, 1, 1);
    ctx.fillRect(dx + 15, dy - 1, 1, 1);
    // Ears
    ctx.fillStyle = C.dogDark;
    ctx.fillRect(dx + 18, dy - 6, 4, 5);
    // Duck in mouth
    ctx.fillStyle = C.duckGreen;
    ctx.fillRect(dx - 2, dy - 2, 8, 6);
    ctx.fillStyle = C.duckBrown;
    ctx.fillRect(dx - 4, dy + 2, 10, 4);
  } else if (state === "laughing") {
    // Dog pops up laughing - head tilted back
    const laughBob = animFrame % 8 < 4 ? 0 : -2;
    ctx.fillStyle = C.dogBrown;
    ctx.fillRect(dx + 2, dy + 4 + laughBob, 16, 14);
    ctx.fillStyle = C.dogLight;
    ctx.fillRect(dx + 8, dy - 6 + laughBob, 12, 12);
    ctx.fillRect(dx + 6, dy - 4 + laughBob, 16, 8);
    // Open laughing mouth
    ctx.fillStyle = C.dogMouth;
    ctx.fillRect(dx + 12, dy - 2 + laughBob, 8, 4);
    ctx.fillRect(dx + 13, dy - 3 + laughBob, 6, 1);
    // Eye - scrunched with laughter
    ctx.fillStyle = C.dogEyeB;
    ctx.fillRect(dx + 10, dy - 4 + laughBob, 4, 1);
    // Ears flopping
    ctx.fillStyle = C.dogDark;
    ctx.fillRect(dx + 18, dy - 8 + laughBob, 4, 5);
    ctx.fillRect(dx + 6, dy - 5 + laughBob, 3, 4);
  }

  ctx.restore();
}

function drawCrosshair(ctx: CanvasRenderingContext2D, mx: number, my: number) {
  ctx.fillStyle = C.text;
  // Vertical lines (with gap in center)
  ctx.fillRect(mx, my - 8, 1, 5);
  ctx.fillRect(mx, my + 4, 1, 5);
  // Horizontal lines (with gap in center)
  ctx.fillRect(mx - 8, my, 5, 1);
  ctx.fillRect(mx + 4, my, 5, 1);
  // Small center dot
  ctx.fillStyle = "#ff3030";
  ctx.fillRect(mx, my, 1, 1);
}

function drawHitParticles(ctx: CanvasRenderingContext2D, particles: HitParticle[]) {
  ctx.fillStyle = C.hitWhite;
  for (const p of particles) {
    ctx.globalAlpha = Math.min(1, p.life / 5);
    ctx.fillRect(Math.floor(p.x), Math.floor(p.y), 2, 2);
  }
  ctx.globalAlpha = 1;
}

function spawnDuck(round: number): Duck {
  const speed = duckSpeed(round);
  const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.4; // upward-ish, wider spread
  const startX = 30 + Math.random() * (W - 60); // wider spawn range
  return {
    x: startX,
    y: GRASS_Y - 4,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    alive: true,
    escaping: false,
    escaped: false,
    hit: false,
    falling: false,
    fallVY: 0,
    frameTimer: 0,
    wingFrame: 0,
    lifeFrames: 0,
    facingRight: Math.cos(angle) >= 0,
    spinAngle: 0,
  };
}

function spawnHitParticles(x: number, y: number): HitParticle[] {
  const parts: HitParticle[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI * 2 * i) / 8 + Math.random() * 0.3;
    const speed = 1.5 + Math.random() * 2;
    parts.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 10 + Math.floor(Math.random() * 6),
    });
  }
  return parts;
}

/* ---- Generate stars once ---- */
function genStars(): [number, number][] {
  const stars: [number, number][] = [];
  for (let i = 0; i < 40; i++) {
    stars.push([
      Math.floor(Math.random() * W),
      Math.floor(Math.random() * (TREE_LINE_Y - 20)),
    ]);
  }
  return stars;
}

/* ============================================================ */
/*  Component                                                     */
/* ============================================================ */

export default function DuckHuntGame({ onAddHighscore, paused = false }: DuckHuntGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);

  const [containerSize, setContainerSize] = useState({ w: 400, h: 400 });
  const [phase, setPhase] = useState<GamePhase>("idle");
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [showResults, setShowResults] = useState(false);

  const phaseRef = useRef<GamePhase>("idle");
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Game state refs
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const accumRef = useRef(0);

  const scoreRef = useRef(0);
  const bestRef = useRef(0);
  const roundRef = useRef(1);
  const duckIndexRef = useRef(0); // which duck in the round (0-9)
  const ducksHitRef = useRef<boolean[]>([]);
  const totalHitsRef = useRef(0);
  const roundsCompletedRef = useRef(0);
  const shotsLeftRef = useRef(SHOTS_PER_DUCK);

  const ducksRef = useRef<Duck[]>([]);
  const particlesRef = useRef<HitParticle[]>([]);

  // Mouse position in canvas space (ref-only, no re-renders)
  const mouseRef = useRef({ x: W / 2, y: H / 2 });

  // Cached canvas bounding rect (updated on resize only, not every mouse move)
  const canvasRectRef = useRef<DOMRect | null>(null);

  // Dog state
  const dogStateRef = useRef<DogState>("hidden");
  const dogTimerRef = useRef(0);
  const dogAnimFrame = useRef(0);
  const dogXRef = useRef(DOG_X);
  const dogYRef = useRef(DOG_GROUND_Y);

  // Death animation
  const flashFrames = useRef(0);
  const deathFrameCount = useRef(0);

  // Phase timing (between ducks)
  const betweenDuckTimer = useRef(0);
  const waitingForDuck = useRef(false);

  // Static terrain
  const treeHeightsRef = useRef<number[] | null>(null);
  if (!treeHeightsRef.current) treeHeightsRef.current = genTreeLine();
  const treeHeights = treeHeightsRef.current;

  const starsRef = useRef<[number, number][] | null>(null);
  if (!starsRef.current) starsRef.current = genStars();
  const stars = starsRef.current;

  // Display-only state for results
  const finalRoundRef = useRef(1);
  const finalHitsRef = useRef(0);

  // CSS canvas sizing (roughly 256:240 = ~1.067 aspect)
  const aspect = W / H;
  const cAspect = containerSize.w / containerSize.h;
  const cssW = cAspect > aspect ? Math.floor(containerSize.h * aspect) : containerSize.w;
  const cssH = cAspect > aspect ? containerSize.h : Math.floor(containerSize.w / aspect);

  /* ---- ResizeObserver ---- */
  useEffect(() => {
    const area = canvasAreaRef.current;
    if (!area) return;
    const updateRect = () => {
      const c = canvasRef.current;
      if (c) canvasRectRef.current = c.getBoundingClientRect();
    };
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        if (width > 0 && height > 0) setContainerSize({ w: Math.floor(width), h: Math.floor(height) });
      }
      // Re-cache canvas rect after resize settles
      requestAnimationFrame(updateRect);
    });
    ro.observe(area);
    // Initial rect cache
    requestAnimationFrame(updateRect);
    return () => ro.disconnect();
  }, []);

  /* ---- Canvas setup ---- */
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = W;
    c.height = H;
  }, []);

  /* ---- Re-cache canvas rect when CSS dimensions change ---- */
  useEffect(() => {
    requestAnimationFrame(() => {
      const c = canvasRef.current;
      if (c) canvasRectRef.current = c.getBoundingClientRect();
    });
  }, [cssW, cssH]);

  /* ---- Init game ---- */
  const initGame = useCallback(() => {
    scoreRef.current = 0;
    bestRef.current = bestRef.current; // keep best
    roundRef.current = 1;
    duckIndexRef.current = 0;
    ducksHitRef.current = [];
    totalHitsRef.current = 0;
    roundsCompletedRef.current = 0;
    shotsLeftRef.current = SHOTS_PER_DUCK;
    ducksRef.current = [];
    particlesRef.current = [];
    dogStateRef.current = "sniffing";
    dogTimerRef.current = 0;
    dogAnimFrame.current = 0;
    dogXRef.current = -DOG_W;
    dogYRef.current = DOG_GROUND_Y;
    flashFrames.current = 0;
    deathFrameCount.current = 0;
    betweenDuckTimer.current = 40; // dog sniffs before first duck
    waitingForDuck.current = true;
    accumRef.current = 0;
    lastTimeRef.current = 0;
    setShowResults(false);
    setScore(0);
    setPhase("playing");
    phaseRef.current = "playing";
  }, []);

  /* ---- Start dying ---- */
  const startDying = useCallback(() => {
    if (phaseRef.current === "dying") return;
    phaseRef.current = "dying";
    setPhase("dying");
    flashFrames.current = 8;
    deathFrameCount.current = 0;
    lastTimeRef.current = 0;
    accumRef.current = 0;
    finalRoundRef.current = roundRef.current;
    finalHitsRef.current = totalHitsRef.current;
  }, []);

  /* ---- Finish death ---- */
  const finishDeath = useCallback(() => {
    phaseRef.current = "over";
    setPhase("over");
    const s = scoreRef.current;
    if (s > 0) onAddHighscore(s);
    if (s > bestRef.current) {
      bestRef.current = s;
      setBestScore(s);
    }
  }, [onAddHighscore]);

  /* ---- Launch next duck(s) ---- */
  const launchDuck = useCallback(() => {
    const round = roundRef.current;
    const remaining = DUCKS_PER_ROUND - duckIndexRef.current;
    // Clamp wave size so we don't exceed the round's duck count
    const count = Math.min(ducksPerWave(round, duckIndexRef.current), remaining);
    const newDucks: Duck[] = [];
    for (let i = 0; i < count; i++) {
      newDucks.push(spawnDuck(round));
    }
    ducksRef.current = newDucks;
    // Give extra shots for double ducks
    shotsLeftRef.current = SHOTS_PER_DUCK * count;
    waitingForDuck.current = false;
    dogStateRef.current = "jumping";
    dogTimerRef.current = 15;
  }, []);

  /* ---- Handle wave completion (all ducks in wave resolved) ---- */
  const completeWave = useCallback((waveHits: boolean[]) => {
    // Push each duck's result into the round tracker
    for (const wasHit of waveHits) {
      ducksHitRef.current.push(wasHit);
      if (wasHit) totalHitsRef.current++;
      duckIndexRef.current++;
    }

    // Show dog reaction based on whether any duck was hit
    const anyHit = waveHits.some(Boolean);
    if (anyHit) {
      dogStateRef.current = "holding";
    } else {
      dogStateRef.current = "laughing";
    }
    dogTimerRef.current = 45;
    dogXRef.current = DOG_X;
    dogYRef.current = DOG_GROUND_Y;

    // Check if round is complete
    if (duckIndexRef.current >= DUCKS_PER_ROUND) {
      // End of round — check if enough ducks hit
      const hitsThisRound = ducksHitRef.current.filter(Boolean).length;
      const minHits = minHitsForRound(roundRef.current);

      if (hitsThisRound < minHits) {
        // Failed — game over after dog reaction
        betweenDuckTimer.current = betweenDuckDelay(roundRef.current);
        waitingForDuck.current = true;
        return "fail";
      }

      // Perfect bonus
      if (hitsThisRound === DUCKS_PER_ROUND) {
        scoreRef.current += PERFECT_BONUS;
        setScore(scoreRef.current);
      }

      // Advance round
      roundsCompletedRef.current++;
      roundRef.current++;
      duckIndexRef.current = 0;
      ducksHitRef.current = [];
      betweenDuckTimer.current = betweenRoundDelay(roundRef.current);
      waitingForDuck.current = true;
      dogStateRef.current = "sniffing";
      dogXRef.current = -DOG_W;
      return "advance";
    }

    betweenDuckTimer.current = betweenDuckDelay(roundRef.current);
    waitingForDuck.current = true;
    return "next";
  }, []);

  /* ---- Shoot (canvas click handler) ---- */
  const handleShoot = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (phaseRef.current !== "playing" || pausedRef.current) return;
    if (waitingForDuck.current) return;

    // Use cached rect for coordinate mapping
    const rect = canvasRectRef.current;
    if (!rect) return;

    const scaleX = W / rect.width;
    const scaleY = H / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;

    if (shotsLeftRef.current <= 0) return;
    shotsLeftRef.current--;

    // Check hit against all active ducks (first hit wins the shot)
    for (const duck of ducksRef.current) {
      if (!duck.alive || duck.falling || duck.escaped) continue;

      const hitDist = 12;
      const ddx = cx - duck.x;
      const ddy = cy - duck.y;
      if (ddx * ddx + ddy * ddy < hitDist * hitDist) {
        // Hit!
        duck.alive = false;
        duck.hit = true;
        duck.falling = true;
        duck.fallVY = -2;
        duck.vx = 0;
        duck.vy = 0;

        // Score
        const pts = BASE_SCORE * roundRef.current;
        scoreRef.current += pts;
        setScore(scoreRef.current);

        // Hit particles
        particlesRef.current.push(...spawnHitParticles(duck.x, duck.y));
        break; // one shot hits one duck
      }
    }
  }, []);

  /* ---- Mouse move handler (ref-only, no re-renders) ---- */
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRectRef.current;
    if (!rect) return;
    const scaleX = W / rect.width;
    const scaleY = H / rect.height;
    mouseRef.current.x = (e.clientX - rect.left) * scaleX;
    mouseRef.current.y = (e.clientY - rect.top) * scaleY;
  }, []);

  /* ---- Draw ref ---- */
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    const round = roundRef.current;

    // Sky
    drawSky(ctx, round);

    // Stars (later rounds)
    drawStars(ctx, round, stars);

    // Tree line
    drawTreeLine(ctx, treeHeights);

    // Ducks (behind grass if near bottom)
    for (const duck of ducksRef.current) {
      if (duck.alive || duck.falling) {
        drawDuck(ctx, duck);
      }
    }

    // Hit particles
    if (particlesRef.current.length > 0) {
      drawHitParticles(ctx, particlesRef.current);
    }

    // Grass (drawn over duck feet)
    drawGrass(ctx);

    // Dog
    drawDog(
      ctx,
      dogStateRef.current,
      dogXRef.current,
      dogYRef.current,
      dogAnimFrame.current,
    );

    // HUD
    drawHUD(
      ctx,
      round,
      scoreRef.current,
      shotsLeftRef.current,
      ducksHitRef.current,
    );

    // Crosshair (only during active play, not during transitions)
    if (phaseRef.current === "playing" && !waitingForDuck.current) {
      drawCrosshair(ctx, Math.floor(mouseRef.current.x), Math.floor(mouseRef.current.y));
    }

    // Score text in sky
    if (phaseRef.current !== "idle") {
      const s = String(scoreRef.current);
      ctx.font = "bold 14px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = C.textSh;
      ctx.fillText(s, W / 2 + 1, 9);
      ctx.fillStyle = C.text;
      ctx.fillText(s, W / 2, 8);
    }

    // Death flash overlay
    if (flashFrames.current > 0) {
      ctx.fillStyle = C.text;
      ctx.globalAlpha = (flashFrames.current / 8) * 0.7;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    // "ROUND X" text at start of round
    if (waitingForDuck.current && betweenDuckTimer.current > 20 && duckIndexRef.current === 0 && phaseRef.current === "playing") {
      ctx.font = "bold 16px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = C.textSh;
      ctx.fillText(`ROUND ${round}`, W / 2 + 1, 61);
      ctx.fillStyle = C.text;
      ctx.fillText(`ROUND ${round}`, W / 2, 60);
    }
  };

  /* ---- failAfterDogRef: schedule game over after dog reaction ---- */
  const failAfterDogRef = useRef(false);

  /* ---- Main game loop (playing phase) ---- */
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

        dogAnimFrame.current++;

        // Dog timer (for reaction animations)
        if (dogTimerRef.current > 0) {
          dogTimerRef.current--;
          if (dogTimerRef.current === 0) {
            if (dogStateRef.current === "jumping") {
              dogStateRef.current = "hidden";
            } else if (dogStateRef.current === "holding" || dogStateRef.current === "laughing") {
              dogStateRef.current = "hidden";
            }
          }
        }

        // Between-duck waiting
        if (waitingForDuck.current) {
          betweenDuckTimer.current--;

          // Dog sniff walk animation
          if (dogStateRef.current === "sniffing") {
            dogXRef.current += 1.2;
            if (dogXRef.current > W / 2 - DOG_W / 2 + 10) {
              dogXRef.current = W / 2 - DOG_W / 2 + 10;
            }
          }

          if (betweenDuckTimer.current <= 0) {
            // Check if we should die (failed round, dog reaction done)
            if (failAfterDogRef.current) {
              failAfterDogRef.current = false;
              startDying();
              drawRef.current();
              return;
            }
            launchDuck();
          }
          continue;
        }

        // Active duck logic — iterate all ducks in the wave
        const round = roundRef.current;
        const escapeLimit = escapeFrames(round);
        const jinkP = jinkChance(round);
        const jinkM = jinkMag(round);
        const speed = duckSpeed(round);

        for (const duck of ducksRef.current) {
          if (duck.falling) {
            // Duck falling after hit
            duck.fallVY += 0.5;
            duck.y += duck.fallVY;
            duck.spinAngle += 0.3;
            // Mark as done when below grass
            if (duck.y > GRASS_Y + 10) {
              duck.falling = false;
              duck.escaped = true; // reuse flag to mean "resolved"
            }
          } else if (duck.alive) {
            duck.lifeFrames++;

            // Wing animation (alternates every 4 frames)
            duck.frameTimer++;
            if (duck.frameTimer >= 4) {
              duck.frameTimer = 0;
              duck.wingFrame = duck.wingFrame === 0 ? 1 : 0;
            }

            // Check escape timer
            if (duck.lifeFrames >= escapeLimit) {
              duck.escaping = true;
              duck.vx = 0;
              duck.vy = -(3.5 + round * 0.15); // fly away faster in later rounds
            }

            // Move duck
            duck.x += duck.vx;
            duck.y += duck.vy;

            // Facing direction
            if (duck.vx > 0.2) duck.facingRight = true;
            else if (duck.vx < -0.2) duck.facingRight = false;

            // Bounce off edges (not if escaping)
            if (!duck.escaping) {
              if (duck.x < DUCK_W / 2) {
                duck.x = DUCK_W / 2;
                duck.vx = Math.abs(duck.vx);
                duck.facingRight = true;
              }
              if (duck.x > W - DUCK_W / 2) {
                duck.x = W - DUCK_W / 2;
                duck.vx = -Math.abs(duck.vx);
                duck.facingRight = false;
              }
              if (duck.y < DUCK_H / 2 + 20) {
                duck.y = DUCK_H / 2 + 20;
                duck.vy = Math.abs(duck.vy) * 0.8;
              }
              if (duck.y > GRASS_Y - DUCK_H) {
                duck.y = GRASS_Y - DUCK_H;
                duck.vy = -Math.abs(duck.vy);
              }

              // Random direction changes — more frequent and sharper in later rounds
              if (Math.random() < jinkP) {
                duck.vx += (Math.random() - 0.5) * 1.5 * jinkM;
                duck.vy += (Math.random() - 0.5) * 1.0 * jinkM;
                const mag = Math.sqrt(duck.vx * duck.vx + duck.vy * duck.vy);
                if (mag > 0) {
                  duck.vx = (duck.vx / mag) * speed;
                  duck.vy = (duck.vy / mag) * speed;
                }
              }
            }

            // Duck escaped off top
            if (duck.y < -DUCK_H) {
              duck.escaped = true;
              duck.alive = false;
            }

            // Out of shots — all remaining alive ducks escape
            if (shotsLeftRef.current <= 0 && !duck.escaping) {
              duck.escaping = true;
              duck.vx = 0;
              duck.vy = -(3.5 + round * 0.15);
            }
          }
        }

        // Check if wave is fully resolved (all ducks done)
        if (ducksRef.current.length > 0) {
          const allResolved = ducksRef.current.every(
            (d) => (!d.alive && !d.falling) || d.escaped,
          );
          if (allResolved) {
            const waveHits = ducksRef.current.map((d) => d.hit);
            ducksRef.current = [];
            const result = completeWave(waveHits);
            if (result === "fail") {
              failAfterDogRef.current = true;
            }
          }
        }

        // Update particles
        particlesRef.current = particlesRef.current
          .map((p) => ({
            ...p,
            x: p.x + p.vx,
            y: p.y + p.vy,
            vy: p.vy + 0.1,
            life: p.life - 1,
          }))
          .filter((p) => p.life > 0);
      }

      drawRef.current();
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, launchDuck, completeWave, startDying]);

  /* ---- Death animation loop ---- */
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

        if (flashFrames.current > 0) flashFrames.current--;
        deathFrameCount.current++;

        // Dog laughing animation
        dogStateRef.current = "laughing";
        dogXRef.current = DOG_X;
        dogYRef.current = DOG_GROUND_Y;
        dogAnimFrame.current++;

        if (deathFrameCount.current >= 60) {
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

  /* ---- Slide-in results after game over ---- */
  useEffect(() => {
    if (phase === "over") {
      const timer = setTimeout(() => setShowResults(true), 50);
      return () => clearTimeout(timer);
    }
    setShowResults(false);
  }, [phase]);

  /* ---- Idle animation ---- */
  useEffect(() => {
    if (phaseRef.current !== "idle") return;

    // Reset dog for idle display
    dogStateRef.current = "sniffing";
    dogXRef.current = W / 2 - DOG_W / 2;
    dogYRef.current = DOG_GROUND_Y;

    const idleLoop = (time: number) => {
      if (phaseRef.current !== "idle") return;
      dogAnimFrame.current = Math.floor(time / 50);
      drawRef.current();
      rafRef.current = requestAnimationFrame(idleLoop);
    };

    rafRef.current = requestAnimationFrame(idleLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase]);

  /* ---- Re-draw on phase transition ---- */
  useEffect(() => {
    if (phaseRef.current === "over" || phaseRef.current === "dying") drawRef.current();
  }, [phase]);

  /* ---- Keyboard (container-scoped) ---- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const h = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        if (phaseRef.current === "idle") {
          initGame();
        } else if (phaseRef.current === "over") {
          initGame();
        }
      }
    };
    el.addEventListener("keydown", h);
    return () => el.removeEventListener("keydown", h);
  }, [initGame]);

  /* ---- Auto-focus on phase change ---- */
  useEffect(() => {
    containerRef.current?.focus();
  }, [phase]);

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
        backgroundColor: "#0a0a18",
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
        <span
          style={{
            fontSize: 10,
            color: "var(--ezy-text-muted)",
            fontFamily: "monospace",
          }}
        >
          {phase === "idle"
            ? "Click to shoot"
            : `Round ${roundRef.current}`}
        </span>
        {bestScore > 0 && <span>Best: {bestScore}</span>}
      </div>

      {/* Canvas area */}
      <div
        ref={canvasAreaRef}
        data-canvas-area
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0a0a18",
        }}
      >
        <canvas
          ref={canvasRef}
          onClick={handleShoot}
          onMouseMove={handleMouseMove}
          style={{
            display: "block",
            cursor: phase === "playing" && !waitingForDuck.current ? "none" : "pointer",
            width: cssW,
            height: cssH,
            imageRendering: "pixelated",
          }}
        />

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
              backgroundColor: "rgba(0,0,0,0.45)",
              gap: 16,
            }}
          >
            <div
              style={{
                fontSize: 24,
                fontWeight: 700,
                color: "#fff",
                fontFamily: "monospace",
                textShadow: "3px 3px 0 #000",
                letterSpacing: 2,
                textTransform: "uppercase",
              }}
            >
              Duck Hunt
            </div>
            <div
              onClick={() => initGame()}
              style={{
                padding: "8px 24px",
                fontSize: 14,
                fontWeight: 700,
                color: "#0a0a18",
                backgroundColor: "#5eead4",
                borderRadius: 2,
                cursor: "pointer",
                userSelect: "none",
                fontFamily: "monospace",
                textTransform: "uppercase",
                border: "2px solid #3ac0a8",
              }}
            >
              Start Game
            </div>
            <div
              style={{
                fontSize: 11,
                color: "#888",
                fontFamily: "monospace",
                textTransform: "uppercase",
              }}
            >
              Press Space or Click to Play
            </div>
          </div>
        )}

        {/* Game over overlay */}
        {phase === "over" &&
          (() => {
            return (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: showResults
                    ? "rgba(0,0,0,0.55)"
                    : "rgba(0,0,0,0)",
                  transition: "background-color 0.4s ease",
                  pointerEvents: showResults ? "auto" : "none",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 8,
                    transform: showResults
                      ? "translateY(0)"
                      : "translateY(60px)",
                    opacity: showResults ? 1 : 0,
                    transition:
                      "transform 0.45s cubic-bezier(0.2, 0.8, 0.3, 1), opacity 0.35s ease",
                  }}
                >
                  <div
                    style={{
                      fontSize: 24,
                      fontWeight: 700,
                      color: "#fff",
                      fontFamily: "monospace",
                      textShadow: "3px 3px 0 #000",
                      letterSpacing: 2,
                      textTransform: "uppercase",
                    }}
                  >
                    Game Over
                  </div>

                  {/* Results card */}
                  <div
                    style={{
                      backgroundColor: "rgba(10,10,24,0.85)",
                      border: "2px solid #333",
                      borderRadius: 4,
                      padding: "12px 24px",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 6,
                      minWidth: 160,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: "#888",
                        fontFamily: "monospace",
                        textTransform: "uppercase",
                        letterSpacing: 1,
                      }}
                    >
                      Score
                    </div>
                    <div
                      style={{
                        fontSize: 36,
                        fontWeight: 700,
                        color: "#5eead4",
                        fontFamily: "monospace",
                        fontVariantNumeric: "tabular-nums",
                        lineHeight: 1,
                      }}
                    >
                      {score}
                    </div>
                    {score > 0 && score >= bestScore && (
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: "#4ade80",
                          fontFamily: "monospace",
                        }}
                      >
                        NEW BEST!
                      </div>
                    )}
                    {bestScore > 0 && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "#666",
                          fontFamily: "monospace",
                        }}
                      >
                        Best: {bestScore}
                      </div>
                    )}

                    {/* Stats */}
                    <div
                      style={{
                        display: "flex",
                        gap: 16,
                        marginTop: 4,
                        fontSize: 11,
                        fontFamily: "monospace",
                        color: "#999",
                      }}
                    >
                      <div style={{ textAlign: "center" }}>
                        <div style={{ color: "#5eead4", fontSize: 18, fontWeight: 700, lineHeight: 1 }}>
                          {finalHitsRef.current}
                        </div>
                        <div>Ducks</div>
                      </div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ color: "#5eead4", fontSize: 18, fontWeight: 700, lineHeight: 1 }}>
                          {roundsCompletedRef.current}
                        </div>
                        <div>Rounds</div>
                      </div>
                    </div>
                  </div>

                  <div
                    onClick={() => initGame()}
                    style={{
                      padding: "8px 24px",
                      fontSize: 14,
                      fontWeight: 700,
                      color: "#0a0a18",
                      backgroundColor: "#5eead4",
                      borderRadius: 2,
                      cursor: "pointer",
                      userSelect: "none",
                      fontFamily: "monospace",
                      textTransform: "uppercase",
                      border: "2px solid #3ac0a8",
                      marginTop: 4,
                    }}
                  >
                    Play Again
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "#888",
                      fontFamily: "monospace",
                      textTransform: "uppercase",
                    }}
                  >
                    Space to Retry
                  </div>
                </div>
              </div>
            );
          })()}

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
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: "#fff",
                fontFamily: "monospace",
                textShadow: "3px 3px 0 #000",
                textTransform: "uppercase",
                letterSpacing: 2,
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

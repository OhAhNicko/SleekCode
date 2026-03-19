import { useRef, useEffect, useState, useCallback } from "react";

interface DonkeyKongGameProps {
  onAddHighscore: (score: number) => void;
  paused?: boolean;
}

type GamePhase = "idle" | "playing" | "dying" | "over";

/* ---- Constants (224x256 native, 30fps) ---- */
const W = 224;
const H = 256;
const FRAME_MS = 1000 / 30;

const MARIO_W = 12;
const MARIO_H = 16;
const MARIO_SPEED = 2;
const JUMP_VEL = -5.5;
const GRAVITY = 0.45;
const LADDER_SPEED = 1.5;

const BARREL_W = 10;
const BARREL_H = 10;
const BARREL_SPEED_BASE = 1.8;

const HAMMER_DURATION = 240; // ~8 seconds at 30fps

const LEVEL_TIME = 120; // seconds per level

/* ---- Platform / level layout ---- */
interface Platform {
  x: number;
  y: number;
  w: number;
  slopeDir: -1 | 0 | 1; // -1 = right-high, 0 = flat, 1 = left-high
  slopeAmount: number;   // pixels of slope across width
}

interface Ladder {
  x: number;
  yTop: number;
  yBot: number;
}

interface HammerSpawn {
  x: number;
  y: number;
  platform: number; // index
}

// Platform Y positions (from bottom to top)
const PLAT_Y = [232, 200, 168, 136, 104, 72];

/** Random int in [min, max] */
function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Build platforms — slopes alternate direction and amount varies per level.
 * Even levels flip the slope pattern so the layout feels different.
 */
function buildPlatforms(level: number): Platform[] {
  const flip = level % 2 === 0; // flip slope pattern on even levels
  const slopeAmt = 3 + Math.min(level, 5); // slopes get steeper (3-8px)
  const s1 = flip ? -1 : 1;
  const s2 = flip ? 1 : -1;
  return [
    { x: 0, y: PLAT_Y[0], w: W, slopeDir: 0, slopeAmount: 0 },
    { x: 8, y: PLAT_Y[1], w: W - 16, slopeDir: s1, slopeAmount: slopeAmt },
    { x: 8, y: PLAT_Y[2], w: W - 16, slopeDir: s2, slopeAmount: slopeAmt },
    { x: 8, y: PLAT_Y[3], w: W - 16, slopeDir: s1, slopeAmount: slopeAmt },
    { x: 8, y: PLAT_Y[4], w: W - 16, slopeDir: s2, slopeAmount: slopeAmt },
    { x: 16, y: PLAT_Y[5], w: 120, slopeDir: 0, slopeAmount: 0 },
  ];
}

/**
 * Build ladders — positions randomized but constrained so:
 * 1. Ladders stay within both connected platforms' horizontal range
 * 2. Adjacent gaps never have ladders at the same X (no free vertical shafts)
 * 3. Each gap has one left-side and one right-side ladder for coverage
 */
function buildLadders(_level: number): Ladder[] {
  const ldrs: Ladder[] = [];

  // Platform horizontal ranges (min X, max X for ladder placement)
  const platRanges: [number, number][] = [
    [16, 196],  // plat 0: full width with margin
    [20, 192],  // plat 1
    [20, 192],  // plat 2
    [20, 192],  // plat 3
    [20, 192],  // plat 4
    [24, 124],  // plat 5: narrow top platform (x=16, w=120)
  ];

  // Track previous gap's ladder X positions to avoid vertical stacking
  let prevLeftX = -100;
  let prevRightX = -100;
  const MIN_VERT_OFFSET = 40; // min horizontal distance between ladders in adjacent gaps

  for (let gap = 0; gap < 5; gap++) {
    const yTop = PLAT_Y[gap + 1];
    const yBot = PLAT_Y[gap];

    // Both connected platforms constrain the valid X range
    const topPlat = platRanges[gap + 1];
    const botPlat = platRanges[gap];
    const xMin = Math.max(topPlat[0], botPlat[0]);
    const xMax = Math.min(topPlat[1], botPlat[1]);

    // Split into left zone and right zone
    const mid = Math.floor((xMin + xMax) / 2);
    const leftZoneMin = xMin;
    const leftZoneMax = mid - 20;
    const rightZoneMin = mid + 20;
    const rightZoneMax = xMax;

    // Pick positions, avoiding vertical alignment with previous gap
    let lx1 = randInt(leftZoneMin, Math.max(leftZoneMin, leftZoneMax));
    let lx2 = randInt(rightZoneMin, Math.max(rightZoneMin, rightZoneMax));

    // Nudge away from previous gap's ladders to prevent shafts
    for (let attempt = 0; attempt < 8; attempt++) {
      if (Math.abs(lx1 - prevLeftX) < MIN_VERT_OFFSET && Math.abs(lx1 - prevRightX) < MIN_VERT_OFFSET) break;
      if (Math.abs(lx1 - prevLeftX) < MIN_VERT_OFFSET || Math.abs(lx1 - prevRightX) < MIN_VERT_OFFSET) {
        lx1 = randInt(leftZoneMin, Math.max(leftZoneMin, leftZoneMax));
      } else break;
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      if (Math.abs(lx2 - prevLeftX) < MIN_VERT_OFFSET && Math.abs(lx2 - prevRightX) < MIN_VERT_OFFSET) break;
      if (Math.abs(lx2 - prevLeftX) < MIN_VERT_OFFSET || Math.abs(lx2 - prevRightX) < MIN_VERT_OFFSET) {
        lx2 = randInt(rightZoneMin, Math.max(rightZoneMin, rightZoneMax));
      } else break;
    }

    prevLeftX = lx1;
    prevRightX = lx2;

    ldrs.push({ x: lx1, yTop, yBot });
    ldrs.push({ x: lx2, yTop, yBot });
  }
  return ldrs;
}

function getHammerSpawns(level: number): HammerSpawn[] {
  // Hammer position varies per level
  const flip = level % 2 === 0;
  return [
    { x: flip ? 190 : 20, y: PLAT_Y[2] - 12, platform: 2 },
    { x: flip ? 20 : 190, y: PLAT_Y[4] - 12, platform: 4 },
  ];
}

/** Get the Y position on a platform at a given X (accounting for slope) */
function platYAt(plat: Platform, x: number): number {
  if (plat.slopeDir === 0) return plat.y;
  const t = (x - plat.x) / plat.w; // 0..1 across platform
  if (plat.slopeDir === 1) {
    // Left-high: y at left = plat.y - slopeAmount, y at right = plat.y
    return plat.y - plat.slopeAmount * (1 - t);
  }
  // Right-high: y at left = plat.y, y at right = plat.y - slopeAmount
  return plat.y - plat.slopeAmount * t;
}

/** Check if x is within a platform horizontally */
function onPlatHoriz(plat: Platform, x: number, w: number): boolean {
  return x + w > plat.x && x < plat.x + plat.w;
}

/* ---- Barrel state ---- */
interface Barrel {
  x: number;
  y: number;
  vx: number;
  vy: number;
  onLadder: boolean;
  ladderIdx: number; // which ladder index the barrel is on (-1 if not on ladder)
  platIdx: number; // which platform it's rolling on (-1 if falling)
  frame: number;
  scored: boolean; // jumped over
  passedLadders: Set<number>; // ladder indices already passed on this platform (prevents re-rolling same ladder)
}

/* ---- Hammer pickup state ---- */
interface HammerPickup {
  x: number;
  y: number;
  active: boolean;
}

/* ---- Colors ---- */
const C = {
  bg: "#000000",
  girder: "#cc3333",
  girderHi: "#ff5555",
  girderSh: "#881111",
  ladder: "#55ccdd",
  ladderSh: "#338899",
  // Mario
  marioHat: "#cc2222",
  marioSkin: "#ffaa77",
  marioShirt: "#5577cc",
  marioOveralls: "#cc2222",
  // DK
  dkBrown: "#995522",
  dkLight: "#cc7733",
  dkDark: "#663311",
  dkChest: "#bb8844",
  // Pauline
  paulineDress: "#ee5577",
  paulineHair: "#553311",
  paulineSkin: "#ffaa77",
  // Barrel
  barrelBody: "#996633",
  barrelStripe: "#664422",
  barrelHi: "#bb8844",
  // Hammer
  hammerHead: "#888888",
  hammerHandle: "#996633",
  // Text
  text: "#ffffff",
  textSh: "#000000",
  textAccent: "#5eead4",
  heartRed: "#ee3344",
};

/* ---- Draw helpers ---- */

function drawPlatforms(ctx: CanvasRenderingContext2D, platforms: Platform[]) {
  for (const p of platforms) {
    for (let px = p.x; px < p.x + p.w; px += 8) {
      const segW = Math.min(8, p.x + p.w - px);
      const sy = Math.floor(platYAt(p, px));
      // Girder block (red brick pattern)
      ctx.fillStyle = C.girder;
      ctx.fillRect(px, sy, segW, 4);
      ctx.fillStyle = C.girderHi;
      ctx.fillRect(px, sy, segW, 1);
      // Brick lines
      ctx.fillStyle = C.girderSh;
      ctx.fillRect(px + 4, sy + 1, 1, 2);
      if (px % 16 < 8) {
        ctx.fillRect(px, sy + 3, segW, 1);
      }
    }
  }
}

function drawLadders(ctx: CanvasRenderingContext2D, ladders: Ladder[]) {
  for (const l of ladders) {
    const h = l.yBot - l.yTop;
    // Side rails
    ctx.fillStyle = C.ladder;
    ctx.fillRect(l.x, l.yTop, 2, h);
    ctx.fillRect(l.x + 8, l.yTop, 2, h);
    // Rungs
    ctx.fillStyle = C.ladderSh;
    for (let ry = l.yTop + 4; ry < l.yBot; ry += 6) {
      ctx.fillRect(l.x + 2, ry, 6, 1);
    }
  }
}

function drawMario(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  frame: number,
  facingRight: boolean,
  climbing: boolean,
  hasHammer: boolean,
  hammerFrame: number,
  dying: boolean,
  deathAngle: number,
) {
  ctx.save();

  if (dying) {
    const cx = x + MARIO_W / 2;
    const cy = y + MARIO_H / 2;
    ctx.translate(cx, cy);
    ctx.rotate(deathAngle);
    ctx.translate(-cx, -cy);
  }

  const mx = Math.floor(x);
  const my = Math.floor(y);

  if (!facingRight && !climbing) {
    ctx.save();
    ctx.translate(mx + MARIO_W, 0);
    ctx.scale(-1, 1);
    drawMarioSprite(ctx, 0, my, frame, climbing);
    ctx.restore();
  } else {
    drawMarioSprite(ctx, mx, my, frame, climbing);
  }

  // Hammer
  if (hasHammer && !dying) {
    const hx = facingRight ? mx + MARIO_W - 2 : mx - 10;
    const hy = hammerFrame % 2 === 0 ? my - 8 : my + 2;
    ctx.fillStyle = C.hammerHandle;
    ctx.fillRect(hx + 3, hy + 6, 2, 8);
    ctx.fillStyle = C.hammerHead;
    ctx.fillRect(hx, hy, 8, 6);
    ctx.fillStyle = "#aaaaaa";
    ctx.fillRect(hx, hy, 8, 1);
  }

  ctx.restore();
}

function drawMarioSprite(
  ctx: CanvasRenderingContext2D,
  mx: number,
  my: number,
  frame: number,
  climbing: boolean,
) {
  // Hat
  ctx.fillStyle = C.marioHat;
  ctx.fillRect(mx + 2, my, 8, 3);
  ctx.fillRect(mx + 1, my + 1, 10, 2);
  // Face
  ctx.fillStyle = C.marioSkin;
  ctx.fillRect(mx + 2, my + 3, 8, 4);
  // Eyes
  ctx.fillStyle = "#000000";
  ctx.fillRect(mx + 7, my + 4, 2, 2);
  // Shirt
  ctx.fillStyle = C.marioShirt;
  ctx.fillRect(mx + 1, my + 7, 10, 4);
  // Overalls
  ctx.fillStyle = C.marioOveralls;
  ctx.fillRect(mx + 3, my + 8, 6, 3);
  // Legs (walk animation)
  ctx.fillStyle = C.marioShirt;
  if (climbing) {
    const legOff = frame % 2 === 0 ? 1 : -1;
    ctx.fillRect(mx + 2 + legOff, my + 11, 3, 5);
    ctx.fillRect(mx + 7 - legOff, my + 11, 3, 5);
  } else {
    if (frame % 2 === 0) {
      ctx.fillRect(mx + 1, my + 11, 4, 5);
      ctx.fillRect(mx + 7, my + 11, 4, 5);
    } else {
      ctx.fillRect(mx + 2, my + 11, 4, 5);
      ctx.fillRect(mx + 6, my + 11, 4, 5);
    }
  }
  // Shoes
  ctx.fillStyle = "#553311";
  ctx.fillRect(mx + 1, my + 14, 4, 2);
  ctx.fillRect(mx + 7, my + 14, 4, 2);
}

function drawDK(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  throwing: boolean,
  throwFrame: number,
) {
  const dx = Math.floor(x);
  const dy = Math.floor(y);
  // Body
  ctx.fillStyle = C.dkBrown;
  ctx.fillRect(dx + 4, dy + 6, 20, 18);
  ctx.fillRect(dx + 6, dy + 4, 16, 2);
  // Chest
  ctx.fillStyle = C.dkChest;
  ctx.fillRect(dx + 8, dy + 10, 12, 8);
  // Head
  ctx.fillStyle = C.dkBrown;
  ctx.fillRect(dx + 6, dy, 16, 8);
  ctx.fillStyle = C.dkLight;
  ctx.fillRect(dx + 8, dy + 2, 12, 4);
  // Eyes
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(dx + 10, dy + 2, 3, 3);
  ctx.fillRect(dx + 16, dy + 2, 3, 3);
  ctx.fillStyle = "#000000";
  ctx.fillRect(dx + 11, dy + 3, 2, 2);
  ctx.fillRect(dx + 17, dy + 3, 2, 2);
  // Mouth
  ctx.fillStyle = C.dkDark;
  ctx.fillRect(dx + 10, dy + 6, 8, 2);
  // Arms (throwing animation)
  ctx.fillStyle = C.dkBrown;
  if (throwing && throwFrame < 8) {
    // Arms raised with barrel
    ctx.fillRect(dx, dy + 2, 4, 8);
    ctx.fillRect(dx + 24, dy + 2, 4, 8);
    // Barrel in hands
    ctx.fillStyle = C.barrelBody;
    ctx.fillRect(dx + 4, dy - 4, 20, 8);
    ctx.fillStyle = C.barrelStripe;
    ctx.fillRect(dx + 4, dy - 1, 20, 2);
  } else {
    // Arms at sides / slightly raised
    ctx.fillRect(dx, dy + 8, 4, 12);
    ctx.fillRect(dx + 24, dy + 8, 4, 12);
  }
  // Legs
  ctx.fillStyle = C.dkDark;
  ctx.fillRect(dx + 6, dy + 24, 6, 4);
  ctx.fillRect(dx + 16, dy + 24, 6, 4);
}

function drawPauline(ctx: CanvasRenderingContext2D, x: number, y: number, frame: number) {
  const px = Math.floor(x);
  const py = Math.floor(y);
  // Hair
  ctx.fillStyle = C.paulineHair;
  ctx.fillRect(px + 1, py, 6, 5);
  // Face
  ctx.fillStyle = C.paulineSkin;
  ctx.fillRect(px + 2, py + 2, 4, 3);
  // Dress
  ctx.fillStyle = C.paulineDress;
  ctx.fillRect(px + 1, py + 5, 6, 8);
  ctx.fillRect(px, py + 7, 8, 4);
  // Legs
  ctx.fillStyle = C.paulineSkin;
  ctx.fillRect(px + 2, py + 13, 2, 3);
  ctx.fillRect(px + 5, py + 13, 2, 3);
  // "HELP!" text above — alternating visibility
  if (frame % 60 < 40) {
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 6px monospace";
    ctx.textAlign = "center";
    ctx.fillText("HELP!", px + 4, py - 3);
  }
}

function drawBarrel(ctx: CanvasRenderingContext2D, b: Barrel) {
  const bx = Math.floor(b.x);
  const by = Math.floor(b.y);

  if (b.onLadder) {
    // Barrel rolling down ladder — draw with tumbling rotation effect
    ctx.save();
    const cx = bx + BARREL_W / 2;
    const cy = by + BARREL_H / 2;
    const angle = (b.frame * 0.15) % (Math.PI * 2);
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.translate(-cx, -cy);
    // Body
    ctx.fillStyle = C.barrelBody;
    ctx.fillRect(bx + 1, by, BARREL_W - 2, BARREL_H);
    ctx.fillRect(bx, by + 1, BARREL_W, BARREL_H - 2);
    // Stripe (animated)
    ctx.fillStyle = C.barrelStripe;
    ctx.fillRect(bx + 1, by + 3 + (b.frame % 3), BARREL_W - 2, 2);
    // Highlight
    ctx.fillStyle = C.barrelHi;
    ctx.fillRect(bx + 2, by + 1, 3, 1);
    ctx.restore();
  } else {
    // Normal rolling barrel on girder
    ctx.fillStyle = C.barrelBody;
    ctx.fillRect(bx + 1, by, BARREL_W - 2, BARREL_H);
    ctx.fillRect(bx, by + 1, BARREL_W, BARREL_H - 2);
    // Stripe
    ctx.fillStyle = C.barrelStripe;
    const stripeOff = b.frame % 4;
    ctx.fillRect(bx + 1, by + 3 + stripeOff % 2, BARREL_W - 2, 2);
    // Highlight
    ctx.fillStyle = C.barrelHi;
    ctx.fillRect(bx + 2, by + 1, 3, 1);
  }
}

function drawHammer(ctx: CanvasRenderingContext2D, h: HammerPickup) {
  if (!h.active) return;
  const hx = Math.floor(h.x);
  const hy = Math.floor(h.y);
  // Handle
  ctx.fillStyle = C.hammerHandle;
  ctx.fillRect(hx + 3, hy + 6, 2, 6);
  // Head
  ctx.fillStyle = C.hammerHead;
  ctx.fillRect(hx, hy, 8, 6);
  ctx.fillStyle = "#aaaaaa";
  ctx.fillRect(hx, hy, 8, 1);
}

/* ---- Component ---- */

export default function DonkeyKongGame({ onAddHighscore, paused = false }: DonkeyKongGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);

  const [containerSize, setContainerSize] = useState({ w: 400, h: 500 });
  const [phase, setPhase] = useState<GamePhase>("idle");
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [showResults, setShowResults] = useState(false);

  // Refs for game state (mutable, no re-render)
  const phaseRef = useRef<GamePhase>("idle");
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const accumRef = useRef(0);

  // Mario state
  const marioX = useRef(24);
  const marioY = useRef(PLAT_Y[0] - MARIO_H);
  const marioVX = useRef(0);
  const marioVY = useRef(0);
  const marioOnGround = useRef(true);
  const marioClimbing = useRef(false);
  const marioFacing = useRef(true); // true = right
  const marioFrame = useRef(0);
  const marioFrameTimer = useRef(0);
  const marioPlatIdx = useRef(0);
  const marioJumping = useRef(false);

  // Hammer state
  const hasHammer = useRef(false);
  const hammerTimer = useRef(0);
  const hammerFrame = useRef(0);

  // Level state
  const platforms = useRef<Platform[]>(buildPlatforms(1));
  const ladders = useRef<Ladder[]>(buildLadders(1));
  const hammerPickups = useRef<HammerPickup[]>([]);
  const barrels = useRef<Barrel[]>([]);
  const scoreRef = useRef(0);
  const bestRef = useRef(0);
  const levelRef = useRef(1);
  const livesRef = useRef(3);
  const timerRef = useRef(LEVEL_TIME * 30); // in frames
  const barrelsJumped = useRef(0);
  const globalFrame = useRef(0);

  // DK state
  const dkThrowing = useRef(false);
  const dkThrowFrame = useRef(0);
  const dkThrowCooldown = useRef(60); // frames until next barrel

  // Death animation
  const deathAngle = useRef(0);
  const deathVY = useRef(0);
  const deathTimer = useRef(0);
  const flashFrames = useRef(0);

  // Keys held
  const keysRef = useRef<Set<string>>(new Set());

  // Stable refs for callbacks
  const onAddHighscoreRef = useRef(onAddHighscore);
  onAddHighscoreRef.current = onAddHighscore;

  // CSS canvas sizing (preserve 224:256 aspect)
  const aspect = W / H;
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

  // Init canvas dimensions
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = W;
    c.height = H;
  }, []);

  /** Reset mario to start position for current level */
  const resetMario = useCallback(() => {
    marioX.current = 24;
    marioY.current = PLAT_Y[0] - MARIO_H;
    marioVX.current = 0;
    marioVY.current = 0;
    marioOnGround.current = true;
    marioClimbing.current = false;
    marioFacing.current = true;
    marioFrame.current = 0;
    marioJumping.current = false;
    marioPlatIdx.current = 0;
    hasHammer.current = false;
    hammerTimer.current = 0;
  }, []);

  /** Initialize a new game */
  const initGame = useCallback(() => {
    scoreRef.current = 0;
    bestRef.current = bestScore;
    levelRef.current = 1;
    livesRef.current = 3;
    barrelsJumped.current = 0;
    timerRef.current = LEVEL_TIME * 30;
    globalFrame.current = 0;
    barrels.current = [];
    dkThrowing.current = false;
    dkThrowFrame.current = 0;
    dkThrowCooldown.current = 45;
    flashFrames.current = 0;
    deathTimer.current = 0;
    platforms.current = buildPlatforms(1);
    ladders.current = buildLadders(1);
    hammerPickups.current = getHammerSpawns(1).map((h) => ({ x: h.x, y: h.y, active: true }));
    resetMario();
    setScore(0);
    setShowResults(false);
    setPhase("playing");
    phaseRef.current = "playing";
    accumRef.current = 0;
    lastTimeRef.current = 0;
  }, [bestScore, resetMario]);

  /** Start next level */
  const nextLevel = useCallback(() => {
    levelRef.current++;
    const lv = levelRef.current;
    timerRef.current = LEVEL_TIME * 30;
    barrels.current = [];
    dkThrowing.current = false;
    dkThrowFrame.current = 0;
    // Faster barrels / more frequent throws per level
    dkThrowCooldown.current = Math.max(15, 45 - lv * 5);
    // Rebuild layout — ladders shift, slopes flip, hammers move
    platforms.current = buildPlatforms(lv);
    ladders.current = buildLadders(lv);
    hammerPickups.current = getHammerSpawns(lv).map((h) => ({ x: h.x, y: h.y, active: true }));
    resetMario();
  }, [resetMario]);

  /** Mario dies */
  const startDying = useCallback(() => {
    if (phaseRef.current === "dying") return;
    phaseRef.current = "dying";
    setPhase("dying");
    flashFrames.current = 6;
    deathAngle.current = 0;
    deathVY.current = -4;
    deathTimer.current = 0;
    lastTimeRef.current = 0;
    accumRef.current = 0;
  }, []);

  /** Finish death — lose life or game over */
  const finishDeath = useCallback(() => {
    livesRef.current--;
    if (livesRef.current <= 0) {
      phaseRef.current = "over";
      setPhase("over");
      const s = scoreRef.current;
      if (s > 0) onAddHighscoreRef.current(s);
      if (s > bestRef.current) {
        bestRef.current = s;
        setBestScore(s);
      }
    } else {
      // Respawn on current level
      barrels.current = [];
      dkThrowing.current = false;
      dkThrowFrame.current = 0;
      resetMario();
      phaseRef.current = "playing";
      setPhase("playing");
      lastTimeRef.current = 0;
      accumRef.current = 0;
    }
  }, [resetMario]);

  /* ---- Find platform under a point ---- */
  const findPlatform = useCallback((x: number, y: number, w: number): { idx: number; surfY: number } | null => {
    const plats = platforms.current;
    for (let i = 0; i < plats.length; i++) {
      const p = plats[i];
      if (!onPlatHoriz(p, x, w)) continue;
      const surfY = platYAt(p, x + w / 2);
      // Check if feet are near the surface
      if (y + MARIO_H >= surfY - 2 && y + MARIO_H <= surfY + 6) {
        return { idx: i, surfY };
      }
    }
    return null;
  }, []);

  /** Check if mario is aligned with a ladder */
  const findLadder = useCallback((x: number, y: number, dir: "up" | "down"): Ladder | null => {
    const mx = x + MARIO_W / 2;
    const my = y + MARIO_H; // feet position
    const curPlatIdx = marioPlatIdx.current;

    for (const l of ladders.current) {
      if (Math.abs(mx - (l.x + 5)) > 8) continue;
      if (dir === "up") {
        // Can only climb UP a ladder whose BOTTOM is at the current platform level.
        // This prevents chaining into ladders that belong to higher gaps.
        if (curPlatIdx >= 0 && curPlatIdx < PLAT_Y.length) {
          const platY = PLAT_Y[curPlatIdx];
          // Ladder bottom (yBot) must be near this platform's Y
          if (Math.abs(l.yBot - platY) > 8) continue;
        }
        if (my >= l.yTop && my <= l.yBot + 4) return l;
      } else {
        // Can only climb DOWN a ladder whose TOP is at the current platform level.
        if (curPlatIdx >= 0 && curPlatIdx < PLAT_Y.length) {
          const platY = PLAT_Y[curPlatIdx];
          if (Math.abs(l.yTop - platY) > 8) continue;
        }
        if (my >= l.yTop - 4 && my <= l.yBot) return l;
      }
    }
    return null;
  }, []);

  /* ---- Draw everything ---- */
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    // Background
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    // Draw platforms
    drawPlatforms(ctx, platforms.current);

    // Draw ladders
    drawLadders(ctx, ladders.current);

    // Draw hammer pickups
    for (const h of hammerPickups.current) {
      drawHammer(ctx, h);
    }

    // Draw barrels
    for (const b of barrels.current) {
      drawBarrel(ctx, b);
    }

    // Draw DK
    const dkX = 24;
    const dkY = PLAT_Y[5] - 28;
    drawDK(ctx, dkX, dkY, dkThrowing.current, dkThrowFrame.current);

    // Draw Pauline
    const paulX = 90;
    const paulY = PLAT_Y[5] - 16;
    drawPauline(ctx, paulX, paulY, globalFrame.current);

    // Draw barrel stack next to DK
    ctx.fillStyle = C.barrelBody;
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(8, PLAT_Y[5] - 10 + i * 6, 12, 5);
      ctx.fillStyle = C.barrelStripe;
      ctx.fillRect(8, PLAT_Y[5] - 8 + i * 6, 12, 1);
      ctx.fillStyle = C.barrelBody;
    }

    // Draw Mario
    drawMario(
      ctx,
      marioX.current,
      marioY.current,
      marioFrame.current,
      marioFacing.current,
      marioClimbing.current,
      hasHammer.current,
      hammerFrame.current,
      phaseRef.current === "dying",
      deathAngle.current,
    );

    // HUD: score, level, time, lives
    ctx.font = "bold 8px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    // Score
    ctx.fillStyle = C.textSh;
    ctx.fillText(`SCORE ${scoreRef.current}`, 5, 3);
    ctx.fillStyle = C.text;
    ctx.fillText(`SCORE ${scoreRef.current}`, 4, 2);

    // Level
    ctx.fillStyle = C.textSh;
    ctx.fillText(`L${levelRef.current}`, W - 30, 3);
    ctx.fillStyle = C.text;
    ctx.fillText(`L${levelRef.current}`, W - 31, 2);

    // Timer
    const secs = Math.max(0, Math.ceil(timerRef.current / 30));
    ctx.textAlign = "center";
    ctx.fillStyle = secs <= 20 ? "#ee3344" : C.text;
    ctx.fillText(`TIME ${secs}`, W / 2, 2);

    // Lives (hearts at bottom-right)
    for (let i = 0; i < livesRef.current; i++) {
      const hx = W - 14 - i * 12;
      const hy = H - 10;
      ctx.fillStyle = C.heartRed;
      // Simple pixel heart
      ctx.fillRect(hx, hy + 1, 2, 3);
      ctx.fillRect(hx + 4, hy + 1, 2, 3);
      ctx.fillRect(hx, hy, 2, 1);
      ctx.fillRect(hx + 4, hy, 2, 1);
      ctx.fillRect(hx + 1, hy + 3, 4, 2);
      ctx.fillRect(hx + 2, hy + 5, 2, 1);
    }

    // Hammer timer indicator
    if (hasHammer.current) {
      const pct = hammerTimer.current / HAMMER_DURATION;
      ctx.fillStyle = "#888888";
      ctx.fillRect(4, H - 6, 40, 3);
      ctx.fillStyle = pct > 0.3 ? "#55ccdd" : "#ee3344";
      ctx.fillRect(4, H - 6, Math.floor(40 * pct), 3);
    }

    // Death flash overlay
    if (flashFrames.current > 0) {
      ctx.fillStyle = C.text;
      ctx.globalAlpha = (flashFrames.current / 6) * 0.7;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  };

  /* ---- Game logic tick ---- */
  const tickRef = useRef<() => void>(() => {});
  tickRef.current = () => {
    const keys = keysRef.current;
    const plats = platforms.current;
    const ldrs = ladders.current;

    globalFrame.current++;

    // Timer
    timerRef.current--;
    if (timerRef.current <= 0) {
      startDying();
      return;
    }

    // ---- Mario input & physics ----
    const onGround = marioOnGround.current;
    const climbing = marioClimbing.current;
    const barrelSpeed = BARREL_SPEED_BASE + (levelRef.current - 1) * 0.3;

    if (climbing) {
      // Climbing logic
      marioVX.current = 0;
      marioVY.current = 0;

      if (keys.has("ArrowUp") || keys.has("w") || keys.has("W")) {
        marioY.current -= LADDER_SPEED;
        marioFrameTimer.current++;
        if (marioFrameTimer.current >= 6) {
          marioFrameTimer.current = 0;
          marioFrame.current = (marioFrame.current + 1) % 2;
        }
      } else if (keys.has("ArrowDown") || keys.has("s") || keys.has("S")) {
        marioY.current += LADDER_SPEED;
        marioFrameTimer.current++;
        if (marioFrameTimer.current >= 6) {
          marioFrameTimer.current = 0;
          marioFrame.current = (marioFrame.current + 1) % 2;
        }
      }

      // Check if reached top or bottom of ladder
      const curLadder = findLadder(marioX.current, marioY.current, "up");
      if (!curLadder) {
        // Check if we've moved off the ladder — land on platform
        marioClimbing.current = false;
        const plat = findPlatform(marioX.current, marioY.current, MARIO_W);
        if (plat) {
          marioY.current = plat.surfY - MARIO_H;
          marioOnGround.current = true;
          marioPlatIdx.current = plat.idx;
        }
      } else {
        // Check if feet reached top of ladder's top platform
        const feetY = marioY.current + MARIO_H;
        if (feetY <= curLadder.yTop + 2) {
          marioClimbing.current = false;
          marioOnGround.current = true;
          marioY.current = curLadder.yTop - MARIO_H;
          // Find which platform we're on
          const plat = findPlatform(marioX.current, marioY.current, MARIO_W);
          if (plat) marioPlatIdx.current = plat.idx;
        } else if (feetY >= curLadder.yBot) {
          marioClimbing.current = false;
          marioOnGround.current = true;
          // Find platform below
          const plat = findPlatform(marioX.current, marioY.current, MARIO_W);
          if (plat) {
            marioY.current = plat.surfY - MARIO_H;
            marioPlatIdx.current = plat.idx;
          }
        }
      }
    } else {
      // Horizontal movement
      let moveX = 0;
      if (keys.has("ArrowLeft") || keys.has("a") || keys.has("A")) {
        moveX = -MARIO_SPEED;
        marioFacing.current = false;
      }
      if (keys.has("ArrowRight") || keys.has("d") || keys.has("D")) {
        moveX = MARIO_SPEED;
        marioFacing.current = true;
      }

      // Walk animation
      if (moveX !== 0 && onGround) {
        marioFrameTimer.current++;
        if (marioFrameTimer.current >= 5) {
          marioFrameTimer.current = 0;
          marioFrame.current = (marioFrame.current + 1) % 2;
        }
      }

      // Jumping
      if ((keys.has(" ") || keys.has("Space")) && onGround && !marioJumping.current) {
        marioVY.current = JUMP_VEL;
        marioOnGround.current = false;
        marioJumping.current = true;
      }

      // Apply gravity
      if (!onGround) {
        marioVY.current += GRAVITY;
      }

      marioX.current += moveX;
      marioY.current += marioVY.current;

      // Clamp horizontal
      if (marioX.current < 0) marioX.current = 0;
      if (marioX.current + MARIO_W > W) marioX.current = W - MARIO_W;

      // Platform collision
      if (marioVY.current >= 0) {
        const plat = findPlatform(marioX.current, marioY.current, MARIO_W);
        if (plat) {
          marioY.current = plat.surfY - MARIO_H;
          marioVY.current = 0;
          marioOnGround.current = true;
          marioJumping.current = false;
          marioPlatIdx.current = plat.idx;
        }
      }

      // Adjust for slope while on ground
      if (marioOnGround.current && marioPlatIdx.current >= 0 && marioPlatIdx.current < plats.length) {
        const p = plats[marioPlatIdx.current];
        if (onPlatHoriz(p, marioX.current, MARIO_W)) {
          const surfY = platYAt(p, marioX.current + MARIO_W / 2);
          marioY.current = surfY - MARIO_H;
        } else {
          // Walked off the edge — start falling
          marioOnGround.current = false;
          marioJumping.current = true;
        }
      }

      // Fall off bottom
      if (marioY.current > H + 20) {
        startDying();
        return;
      }

      // Ladder entry (not while holding hammer)
      if (!hasHammer.current) {
        if (keys.has("ArrowUp") || keys.has("w") || keys.has("W")) {
          const ladder = findLadder(marioX.current, marioY.current, "up");
          if (ladder && onGround) {
            marioClimbing.current = true;
            marioOnGround.current = false;
            marioJumping.current = false;
            marioVY.current = 0;
            marioX.current = ladder.x + 5 - MARIO_W / 2;
          }
        }
        if (keys.has("ArrowDown") || keys.has("s") || keys.has("S")) {
          const ladder = findLadder(marioX.current, marioY.current, "down");
          if (ladder && onGround) {
            marioClimbing.current = true;
            marioOnGround.current = false;
            marioJumping.current = false;
            marioVY.current = 0;
            marioX.current = ladder.x + 5 - MARIO_W / 2;
          }
        }
      }
    }

    // ---- Hammer pickup & timer ----
    if (!hasHammer.current) {
      for (const hp of hammerPickups.current) {
        if (!hp.active) continue;
        const dx = Math.abs((marioX.current + MARIO_W / 2) - (hp.x + 4));
        const dy = Math.abs((marioY.current + MARIO_H / 2) - (hp.y + 6));
        if (dx < 10 && dy < 12) {
          hasHammer.current = true;
          hammerTimer.current = HAMMER_DURATION;
          hp.active = false;
          break;
        }
      }
    } else {
      hammerTimer.current--;
      hammerFrame.current = Math.floor(globalFrame.current / 3) % 2;
      if (hammerTimer.current <= 0) {
        hasHammer.current = false;
      }
    }

    // ---- DK barrel throwing ----
    if (!dkThrowing.current) {
      dkThrowCooldown.current--;
      if (dkThrowCooldown.current <= 0) {
        dkThrowing.current = true;
        dkThrowFrame.current = 0;
      }
    }

    if (dkThrowing.current) {
      dkThrowFrame.current++;
      if (dkThrowFrame.current >= 16) {
        // Spawn barrel — randomly throw left or right for variety
        const throwRight = Math.random() < 0.6; // slight bias to right (toward Pauline)
        const topPlatSurf = platYAt(plats[5], plats[5].x + plats[5].w / 2);
        barrels.current.push({
          x: throwRight ? 50 : plats[5].x + plats[5].w - 50,
          y: topPlatSurf - BARREL_H,
          vx: throwRight ? barrelSpeed : -barrelSpeed,
          vy: 0,
          onLadder: false,
          ladderIdx: -1,
          platIdx: 5,
          frame: 0,
          scored: false,
          passedLadders: new Set(),
        });
        dkThrowing.current = false;
        // Random cooldown scaled by level — aggressive from level 1
        const baseCooldown = Math.max(20, 60 - levelRef.current * 8);
        dkThrowCooldown.current = baseCooldown + Math.floor(Math.random() * 25);
      }
    }

    // ---- Barrel physics ----
    const newBarrels: Barrel[] = [];
    for (const b of barrels.current) {
      b.frame++;

      if (b.onLadder) {
        // Rolling down ladder — slightly variable speed for visual interest
        const ladderSpeed = 1.5 + Math.sin(b.frame * 0.3) * 0.3;
        b.y += ladderSpeed;
        // Check if reached bottom of the ladder it's on
        let landed = false;
        if (b.ladderIdx >= 0 && b.ladderIdx < ldrs.length) {
          const l = ldrs[b.ladderIdx];
          if (b.y + BARREL_H >= l.yBot - 2) {
            // Find platform at bottom
            for (let pi = 0; pi < plats.length; pi++) {
              const p = plats[pi];
              if (onPlatHoriz(p, b.x, BARREL_W)) {
                const surfY = platYAt(p, b.x + BARREL_W / 2);
                if (Math.abs(b.y + BARREL_H - surfY) < 8) {
                  b.y = surfY - BARREL_H;
                  b.onLadder = false;
                  b.ladderIdx = -1;
                  b.platIdx = pi;
                  b.passedLadders = new Set(); // reset for new platform
                  // Roll DOWNHILL: slopeDir=1 means left-high → roll right; -1 means right-high → roll left
                  if (p.slopeDir === 1) b.vx = barrelSpeed;
                  else if (p.slopeDir === -1) b.vx = -barrelSpeed;
                  else b.vx = Math.random() < 0.5 ? barrelSpeed : -barrelSpeed;
                  landed = true;
                  break;
                }
              }
            }
          }
        }
        if (!landed && b.y > H + 20) continue; // remove
        newBarrels.push(b);
        continue;
      }

      // Rolling on platform
      if (b.platIdx >= 0 && b.platIdx < plats.length) {
        const p = plats[b.platIdx];

        // Gravity pulls barrel downhill — correct direction and accelerate
        if (p.slopeDir === 1) {
          // Left-high, right-low → barrel rolls right (positive vx)
          if (b.vx < 0) b.vx = barrelSpeed; // correct uphill to downhill
          b.vx = Math.min(b.vx + 0.02, barrelSpeed * 1.5);
        } else if (p.slopeDir === -1) {
          // Right-high, left-low → barrel rolls left (negative vx)
          if (b.vx > 0) b.vx = -barrelSpeed; // correct uphill to downhill
          b.vx = Math.max(b.vx - 0.02, -barrelSpeed * 1.5);
        }

        b.x += b.vx;

        // Follow slope
        const surfY = platYAt(p, b.x + BARREL_W / 2);
        b.y = surfY - BARREL_H;

        // Check if barrel reached edge of platform
        if (b.x + BARREL_W < p.x || b.x > p.x + p.w) {
          // Check for ladder to go down at the edge
          let tookLadder = false;
          for (let li = 0; li < ldrs.length; li++) {
            const l = ldrs[li];
            if (l.yTop >= p.y - 6 && l.yTop <= p.y + 6) {
              if (Math.abs(b.x + BARREL_W / 2 - (l.x + 5)) < 20) {
                b.onLadder = true;
                b.ladderIdx = li;
                b.x = l.x + 5 - BARREL_W / 2;
                b.vx = 0;
                tookLadder = true;
                break;
              }
            }
          }

          if (!tookLadder) {
            // Fall to next platform
            b.platIdx = -1;
            b.vy = 1;
          }
        } else {
          // Mid-platform: check if barrel crosses over a ladder — 40% chance to take it
          for (let li = 0; li < ldrs.length; li++) {
            if (b.passedLadders.has(li)) continue; // already passed this ladder on this platform
            const l = ldrs[li];
            // Ladder must connect from this platform downward (yTop near this platform's Y)
            if (l.yTop >= p.y - 4 && l.yTop <= p.y + 4) {
              const distToLadder = Math.abs(b.x + BARREL_W / 2 - (l.x + 5));
              if (distToLadder < 4) {
                // Barrel is crossing over this ladder
                b.passedLadders.add(li);
                // 55% base chance to take the ladder down — creates unpredictable barrel paths
                const ladderChance = Math.min(0.75, 0.55 + (levelRef.current - 1) * 0.03);
                if (Math.random() < ladderChance) {
                  b.onLadder = true;
                  b.ladderIdx = li;
                  b.x = l.x + 5 - BARREL_W / 2;
                  b.vx = 0;
                  break;
                }
              }
            }
          }
        }
      } else {
        // Falling
        b.vy += GRAVITY;
        b.y += b.vy;
        b.x += b.vx * 0.3;

        // Check landing on platform
        for (let pi = 0; pi < plats.length; pi++) {
          const p = plats[pi];
          if (!onPlatHoriz(p, b.x, BARREL_W)) continue;
          const surfY = platYAt(p, b.x + BARREL_W / 2);
          if (b.y + BARREL_H >= surfY && b.y + BARREL_H <= surfY + 8) {
            b.y = surfY - BARREL_H;
            b.vy = 0;
            b.platIdx = pi;
            b.passedLadders = new Set(); // reset for new platform
            // Set direction based on slope
            if (p.slopeDir === 1) b.vx = barrelSpeed; // rolls with gravity
            else if (p.slopeDir === -1) b.vx = -barrelSpeed;
            else b.vx = b.vx > 0 ? barrelSpeed : -barrelSpeed;
            break;
          }
        }
      }

      // Remove if off screen
      if (b.y > H + 20) continue;

      newBarrels.push(b);
    }
    barrels.current = newBarrels;

    // ---- Collision: Mario vs Barrels ----
    const mx = marioX.current;
    const my = marioY.current;
    const mfeetY = my + MARIO_H;
    const mcx = mx + MARIO_W / 2;
    const isClimbing = marioClimbing.current;

    for (const b of barrels.current) {
      const bcx = b.x + BARREL_W / 2;
      const bcy = b.y + BARREL_H / 2;
      const dx = Math.abs(mcx - bcx);
      const dy = Math.abs((my + MARIO_H / 2) - bcy);

      // Ladder-specific collision: if barrel is on a ladder and Mario is climbing,
      // use tighter horizontal tolerance (same ladder) but generous vertical overlap
      if (b.onLadder && isClimbing && b.ladderIdx >= 0) {
        const l = ldrs[b.ladderIdx];
        // Check if Mario is on or near this same ladder
        const marioOnThisLadder = Math.abs(mcx - (l.x + 5)) < 10;
        if (marioOnThisLadder) {
          // Vertical overlap check — barrel falling into Mario or Mario climbing into barrel
          const mTop = my;
          const mBot = mfeetY;
          const bTop = b.y;
          const bBot = b.y + BARREL_H;
          if (mBot > bTop + 2 && mTop < bBot - 2) {
            if (hasHammer.current) {
              b.scored = true;
              scoreRef.current += 300;
              setScore(scoreRef.current);
              b.y = H + 100;
            } else {
              startDying();
              return;
            }
          }
        }
      }

      // General AABB collision (works for all barrels — on girders, falling, or ladders)
      if (dx < (MARIO_W + BARREL_W) / 2 - 2 && dy < (MARIO_H + BARREL_H) / 2 - 2) {
        if (hasHammer.current) {
          // Smash barrel
          b.scored = true;
          scoreRef.current += 300;
          setScore(scoreRef.current);
          // Mark for removal
          b.y = H + 100;
        } else {
          startDying();
          return;
        }
      }

      // Score: jumping over barrel
      if (!b.scored && !b.onLadder && marioJumping.current) {
        if (mfeetY < b.y && dx < 20 && my + MARIO_H < b.y + 4) {
          b.scored = true;
          scoreRef.current += 100;
          barrelsJumped.current++;
          setScore(scoreRef.current);
        }
      }
    }

    // Remove smashed barrels
    barrels.current = barrels.current.filter((b) => b.y < H + 50);

    // ---- Win condition: reach top platform near Pauline ----
    if (marioPlatIdx.current === 5 && marioX.current > 70) {
      // Level complete!
      const timeBonus = Math.ceil(timerRef.current / 30) * 10;
      scoreRef.current += timeBonus;
      setScore(scoreRef.current);
      nextLevel();
    }
  };

  /* ---- Main game loop (playing) ---- */
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
        tickRef.current();
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

        // Mario spin + fall
        deathAngle.current += 0.25;
        deathVY.current += 0.3;
        marioY.current += deathVY.current;

        deathTimer.current++;

        // After ~2 seconds, finish death
        if (deathTimer.current >= 60) {
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

  /* ---- Idle animation ---- */
  useEffect(() => {
    if (phaseRef.current !== "idle") return;

    // Draw static scene for idle
    const idleLoop = (time: number) => {
      if (phaseRef.current !== "idle") return;
      globalFrame.current = Math.floor(time / 33);
      drawRef.current();
      rafRef.current = requestAnimationFrame(idleLoop);
    };
    rafRef.current = requestAnimationFrame(idleLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase]);

  // Redraw on phase changes
  useEffect(() => {
    if (phaseRef.current === "over" || phaseRef.current === "dying") drawRef.current();
  }, [phase]);

  /* ---- Results slide-in ---- */
  useEffect(() => {
    if (phase === "over") {
      const timer = setTimeout(() => setShowResults(true), 50);
      return () => clearTimeout(timer);
    }
    setShowResults(false);
  }, [phase]);

  /* ---- Keyboard handlers (scoped to container) ---- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Start / retry
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        if (phaseRef.current === "idle") {
          initGame();
          return;
        }
        if (phaseRef.current === "over") {
          initGame();
          return;
        }
      }

      if (
        e.key === "ArrowUp" || e.key === "ArrowDown" ||
        e.key === "ArrowLeft" || e.key === "ArrowRight" ||
        e.key === "w" || e.key === "W" ||
        e.key === "a" || e.key === "A" ||
        e.key === "s" || e.key === "S" ||
        e.key === "d" || e.key === "D" ||
        e.key === " "
      ) {
        e.preventDefault();
        e.stopPropagation();
      }

      keysRef.current.add(e.key);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key);
    };

    const handleBlur = () => {
      keysRef.current.clear();
    };

    el.addEventListener("keydown", handleKeyDown);
    el.addEventListener("keyup", handleKeyUp);
    el.addEventListener("blur", handleBlur);
    return () => {
      el.removeEventListener("keydown", handleKeyDown);
      el.removeEventListener("keyup", handleKeyUp);
      el.removeEventListener("blur", handleBlur);
    };
  }, [initGame]);

  // Auto-focus on phase change
  useEffect(() => { containerRef.current?.focus(); }, [phase]);

  /* ---- Render ---- */
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
        <span>Score: <span style={{ color: "var(--ezy-accent)" }}>{score}</span></span>
        <span style={{ fontSize: 10, color: "var(--ezy-text-muted)", fontFamily: "monospace" }}>
          {phase === "idle" ? "Arrows to move, Space to jump" : `Level ${levelRef.current}`}
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
          onClick={() => {
            if (phaseRef.current === "idle" || phaseRef.current === "over") initGame();
          }}
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
            backgroundColor: "rgba(0,0,0,0.5)", gap: 16,
          }}>
            <div style={{
              fontSize: 22, fontWeight: 700, color: "#fff",
              fontFamily: "monospace", textShadow: "3px 3px 0 #000",
              letterSpacing: 2, textTransform: "uppercase",
            }}>
              Donkey Kong
            </div>
            <div
              onClick={() => initGame()}
              style={{
                padding: "8px 24px", fontSize: 14, fontWeight: 700,
                color: "#0a0a18", backgroundColor: "#5eead4",
                borderRadius: 2, cursor: "pointer", userSelect: "none",
                fontFamily: "monospace", textTransform: "uppercase",
                border: "2px solid #3ac0a8",
              }}
            >
              Start Game
            </div>
            <div style={{ fontSize: 11, color: "#888", fontFamily: "monospace", textTransform: "uppercase" }}>
              Arrows / WASD to move, Space to jump
            </div>
          </div>
        )}

        {/* Game over overlay */}
        {phase === "over" && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            backgroundColor: showResults ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0)",
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
                fontSize: 22, fontWeight: 700, color: "#fff",
                fontFamily: "monospace", textShadow: "3px 3px 0 #000",
                letterSpacing: 2, textTransform: "uppercase",
              }}>
                Game Over
              </div>

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
                  {score}
                </div>
                {score > 0 && score >= bestScore && (
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#4ade80", fontFamily: "monospace" }}>
                    NEW BEST!
                  </div>
                )}
                {bestScore > 0 && (
                  <div style={{ fontSize: 11, color: "#666", fontFamily: "monospace" }}>
                    Best: {bestScore}
                  </div>
                )}
                <div style={{
                  display: "flex", gap: 16, fontSize: 11, color: "#999",
                  fontFamily: "monospace", marginTop: 4,
                }}>
                  <span>Barrels: {barrelsJumped.current}</span>
                  <span>Level: {levelRef.current}</span>
                </div>
              </div>

              <div
                onClick={() => initGame()}
                style={{
                  padding: "8px 24px", fontSize: 14, fontWeight: 700,
                  color: "#0a0a18", backgroundColor: "#5eead4",
                  borderRadius: 2, cursor: "pointer", userSelect: "none",
                  fontFamily: "monospace", textTransform: "uppercase",
                  border: "2px solid #3ac0a8", marginTop: 4,
                }}
              >
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

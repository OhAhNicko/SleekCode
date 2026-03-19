import { useRef, useEffect, useState, useCallback } from "react";

interface SpaceInvadersGameProps {
  onAddHighscore: (score: number) => void;
  paused?: boolean;
}

type GamePhase = "idle" | "playing" | "dying" | "over";

/* ---- Original Space Invaders resolution (224x256 @ 30 fps) ---- */
const W = 224;
const H = 256;
const FRAME_MS = 1000 / 30;

/* ---- Player constants ---- */
const PLAYER_W = 13;
const PLAYER_H = 8;
const PLAYER_Y = H - 16;
const PLAYER_SPEED = 2;

/* ---- Alien grid ---- */
const ALIEN_COLS = 11;
const ALIEN_ROWS = 5;
const ALIEN_CELL_W = 16;
const ALIEN_CELL_H = 16;
const ALIEN_GRID_TOP = 36;
const ALIEN_START_X = 16;

/* ---- Bullet constants ---- */
const PLAYER_BULLET_SPEED = 4;
const ALIEN_BULLET_SPEED = 2;

/* ---- Shield constants ---- */
const SHIELD_COUNT = 4;
const SHIELD_W = 22;
const SHIELD_H = 16;
const SHIELD_Y = PLAYER_Y - 32;

/* ---- UFO ---- */
const UFO_W = 16;
const UFO_H = 7;
const UFO_SPEED = 1;
const UFO_MIN_INTERVAL = 15000;
const UFO_MAX_INTERVAL = 25000;

/* ---- Point values ---- */
const ALIEN_POINTS = [10, 10, 20, 20, 30]; // rows 0..4 bottom to top in draw order
const UFO_POINTS = [50, 100, 150, 200, 250, 300];

/* ---- Colors ---- */
const C = {
  bg: "#000000",
  player: "#00ff00",
  playerHi: "#66ff66",
  alien1: "#ffffff",   // small (top rows)
  alien2: "#44ffcc",   // medium
  alien3: "#ff4444",   // large (bottom row)
  bullet: "#ffffff",
  alienBullet: "#ff6666",
  shield: "#00ff00",
  ufo: "#ff2222",
  ufoHi: "#ff6666",
  text: "#ffffff",
  textDim: "#888888",
  scoreLabel: "#00ff00",
  explosion: "#ffaa00",
};

/* ---- Alien sprite data (pixel bitmaps) ---- */
// Small alien (8x8) — classic "crab"
const SPRITE_SMALL_A: number[][] = [
  [0,0,1,0,0,0,0,0,1,0,0],
  [0,0,0,1,0,0,0,1,0,0,0],
  [0,0,1,1,1,1,1,1,1,0,0],
  [0,1,1,0,1,1,1,0,1,1,0],
  [1,1,1,1,1,1,1,1,1,1,1],
  [1,0,1,1,1,1,1,1,1,0,1],
  [1,0,1,0,0,0,0,0,1,0,1],
  [0,0,0,1,1,0,1,1,0,0,0],
];
const SPRITE_SMALL_B: number[][] = [
  [0,0,1,0,0,0,0,0,1,0,0],
  [1,0,0,1,0,0,0,1,0,0,1],
  [1,0,1,1,1,1,1,1,1,0,1],
  [1,1,1,0,1,1,1,0,1,1,1],
  [1,1,1,1,1,1,1,1,1,1,1],
  [0,1,1,1,1,1,1,1,1,1,0],
  [0,0,1,0,0,0,0,0,1,0,0],
  [0,1,0,0,0,0,0,0,0,1,0],
];

// Medium alien (11x8) — classic "bug"
const SPRITE_MED_A: number[][] = [
  [0,0,0,1,0,0,0,1,0,0,0],
  [0,0,0,0,1,0,1,0,0,0,0],
  [0,0,0,1,1,1,1,1,0,0,0],
  [0,0,1,1,0,1,0,1,1,0,0],
  [0,1,1,1,1,1,1,1,1,1,0],
  [0,1,0,1,1,1,1,1,0,1,0],
  [0,1,0,1,0,0,0,1,0,1,0],
  [0,0,0,0,1,0,1,0,0,0,0],
];
const SPRITE_MED_B: number[][] = [
  [0,0,0,1,0,0,0,1,0,0,0],
  [0,0,0,0,1,0,1,0,0,0,0],
  [0,0,0,1,1,1,1,1,0,0,0],
  [0,0,1,1,0,1,0,1,1,0,0],
  [0,1,1,1,1,1,1,1,1,1,0],
  [0,0,1,1,1,1,1,1,1,0,0],
  [0,0,1,0,0,0,0,0,1,0,0],
  [0,1,0,0,0,0,0,0,0,1,0],
];

// Large alien (12x8) — classic "squid"
const SPRITE_LARGE_A: number[][] = [
  [0,0,0,0,1,1,1,1,0,0,0,0],
  [0,1,1,1,1,1,1,1,1,1,1,0],
  [1,1,1,1,1,1,1,1,1,1,1,1],
  [1,1,1,0,0,1,1,0,0,1,1,1],
  [1,1,1,1,1,1,1,1,1,1,1,1],
  [0,0,1,1,1,0,0,1,1,1,0,0],
  [0,1,1,0,0,1,1,0,0,1,1,0],
  [0,0,1,1,0,0,0,0,1,1,0,0],
];
const SPRITE_LARGE_B: number[][] = [
  [0,0,0,0,1,1,1,1,0,0,0,0],
  [0,1,1,1,1,1,1,1,1,1,1,0],
  [1,1,1,1,1,1,1,1,1,1,1,1],
  [1,1,1,0,0,1,1,0,0,1,1,1],
  [1,1,1,1,1,1,1,1,1,1,1,1],
  [0,0,0,1,1,0,0,1,1,0,0,0],
  [0,0,1,1,0,1,1,0,1,1,0,0],
  [1,1,0,0,0,0,0,0,0,0,1,1],
];

// Player ship sprite (13x8)
const SPRITE_PLAYER: number[][] = [
  [0,0,0,0,0,0,1,0,0,0,0,0,0],
  [0,0,0,0,0,1,1,1,0,0,0,0,0],
  [0,0,0,0,0,1,1,1,0,0,0,0,0],
  [0,1,1,1,1,1,1,1,1,1,1,1,0],
  [1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1],
];

// UFO sprite (16x7)
const SPRITE_UFO: number[][] = [
  [0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0],
  [0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0],
  [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
  [0,1,1,0,1,1,0,1,1,0,1,1,0,1,1,0],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [0,0,1,1,1,0,0,1,1,0,0,1,1,1,0,0],
  [0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0],
];

// Explosion sprite (13x8)
const SPRITE_EXPLODE: number[][] = [
  [0,0,0,1,0,0,0,0,0,1,0,0,0],
  [1,0,0,0,1,0,0,0,1,0,0,0,1],
  [0,1,0,0,0,0,0,0,0,0,0,1,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,1,0,0,0,0,0,0,0,0,0,1,0],
  [0,0,0,0,1,0,0,0,1,0,0,0,0],
  [0,0,0,1,0,0,0,0,0,1,0,0,0],
  [0,0,1,0,0,0,1,0,0,0,1,0,0],
];

// Shield template (22x16 — arch shape)
function createShieldGrid(): boolean[][] {
  const grid: boolean[][] = [];
  for (let y = 0; y < SHIELD_H; y++) {
    grid[y] = [];
    for (let x = 0; x < SHIELD_W; x++) {
      // Arch shape: filled rectangle with rounded top and notch at bottom
      const cx = SHIELD_W / 2;
      const topR = 8;
      const inArch = y >= 4 || ((x - cx) * (x - cx) + (y - 4) * (y - 4)) <= topR * topR;
      const inNotch = y >= SHIELD_H - 5 && x >= 6 && x < SHIELD_W - 6;
      grid[y][x] = inArch && !inNotch;
    }
  }
  return grid;
}

/* ---- Interfaces ---- */
interface Alien {
  row: number;
  col: number;
  alive: boolean;
}

interface Bullet {
  x: number;
  y: number;
  dy: number;
}

interface Ufo {
  x: number;
  dir: number; // 1 or -1
  active: boolean;
  points: number;
}

interface ExplosionFx {
  x: number;
  y: number;
  timer: number;
  text?: string;
}

interface GameState {
  phase: GamePhase;
  score: number;
  lives: number;
  level: number;
  playerX: number;
  // Alien swarm state
  aliens: Alien[];
  swarmX: number;
  swarmY: number;
  swarmDir: number; // 1 = right, -1 = left
  swarmMoveTimer: number;
  swarmMoveInterval: number;
  animFrame: number;
  // Bullets
  playerBullet: Bullet | null;
  alienBullets: Bullet[];
  // Shields
  shields: boolean[][][]; // [shieldIndex][y][x]
  // UFO
  ufo: Ufo;
  ufoTimer: number;
  // Effects
  explosions: ExplosionFx[];
  dyingTimer: number;
  // Keyboard state
  keys: Set<string>;
}

/* ---- Pixel font (3x5 digits + letters) ---- */
const FONT: Record<string, number[][]> = {
  "0": [[1,1,1],[1,0,1],[1,0,1],[1,0,1],[1,1,1]],
  "1": [[0,1,0],[1,1,0],[0,1,0],[0,1,0],[1,1,1]],
  "2": [[1,1,1],[0,0,1],[1,1,1],[1,0,0],[1,1,1]],
  "3": [[1,1,1],[0,0,1],[1,1,1],[0,0,1],[1,1,1]],
  "4": [[1,0,1],[1,0,1],[1,1,1],[0,0,1],[0,0,1]],
  "5": [[1,1,1],[1,0,0],[1,1,1],[0,0,1],[1,1,1]],
  "6": [[1,1,1],[1,0,0],[1,1,1],[1,0,1],[1,1,1]],
  "7": [[1,1,1],[0,0,1],[0,0,1],[0,0,1],[0,0,1]],
  "8": [[1,1,1],[1,0,1],[1,1,1],[1,0,1],[1,1,1]],
  "9": [[1,1,1],[1,0,1],[1,1,1],[0,0,1],[1,1,1]],
  "A": [[0,1,0],[1,0,1],[1,1,1],[1,0,1],[1,0,1]],
  "B": [[1,1,0],[1,0,1],[1,1,0],[1,0,1],[1,1,0]],
  "C": [[0,1,1],[1,0,0],[1,0,0],[1,0,0],[0,1,1]],
  "D": [[1,1,0],[1,0,1],[1,0,1],[1,0,1],[1,1,0]],
  "E": [[1,1,1],[1,0,0],[1,1,0],[1,0,0],[1,1,1]],
  "F": [[1,1,1],[1,0,0],[1,1,0],[1,0,0],[1,0,0]],
  "G": [[0,1,1],[1,0,0],[1,0,1],[1,0,1],[0,1,1]],
  "H": [[1,0,1],[1,0,1],[1,1,1],[1,0,1],[1,0,1]],
  "I": [[1,1,1],[0,1,0],[0,1,0],[0,1,0],[1,1,1]],
  "L": [[1,0,0],[1,0,0],[1,0,0],[1,0,0],[1,1,1]],
  "N": [[1,0,1],[1,1,1],[1,1,1],[1,0,1],[1,0,1]],
  "O": [[0,1,0],[1,0,1],[1,0,1],[1,0,1],[0,1,0]],
  "P": [[1,1,0],[1,0,1],[1,1,0],[1,0,0],[1,0,0]],
  "R": [[1,1,0],[1,0,1],[1,1,0],[1,0,1],[1,0,1]],
  "S": [[0,1,1],[1,0,0],[0,1,0],[0,0,1],[1,1,0]],
  "T": [[1,1,1],[0,1,0],[0,1,0],[0,1,0],[0,1,0]],
  "U": [[1,0,1],[1,0,1],[1,0,1],[1,0,1],[0,1,0]],
  "V": [[1,0,1],[1,0,1],[1,0,1],[0,1,0],[0,1,0]],
  "W": [[1,0,1],[1,0,1],[1,1,1],[1,1,1],[1,0,1]],
  "X": [[1,0,1],[1,0,1],[0,1,0],[1,0,1],[1,0,1]],
  "Y": [[1,0,1],[1,0,1],[0,1,0],[0,1,0],[0,1,0]],
  " ": [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]],
  ":": [[0,0,0],[0,1,0],[0,0,0],[0,1,0],[0,0,0]],
  "!": [[0,1,0],[0,1,0],[0,1,0],[0,0,0],[0,1,0]],
  "-": [[0,0,0],[0,0,0],[1,1,1],[0,0,0],[0,0,0]],
};

function drawPixelText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, scale: number = 1) {
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const glyph = FONT[ch];
    if (glyph) {
      for (let row = 0; row < glyph.length; row++) {
        for (let col = 0; col < glyph[row].length; col++) {
          if (glyph[row][col]) {
            ctx.fillRect(cx + col * scale, y + row * scale, scale, scale);
          }
        }
      }
      cx += (glyph[0].length + 1) * scale;
    } else {
      cx += 4 * scale;
    }
  }
}

function textPixelWidth(text: string, scale: number = 1): number {
  let w = 0;
  for (const ch of text.toUpperCase()) {
    const glyph = FONT[ch];
    w += glyph ? (glyph[0].length + 1) * scale : 4 * scale;
  }
  return w > 0 ? w - scale : 0; // remove trailing gap
}

/* ---- Draw sprite helper ---- */
function drawSprite(ctx: CanvasRenderingContext2D, sprite: number[][], x: number, y: number, color: string) {
  ctx.fillStyle = color;
  for (let r = 0; r < sprite.length; r++) {
    for (let c = 0; c < sprite[r].length; c++) {
      if (sprite[r][c]) {
        ctx.fillRect(x + c, y + r, 1, 1);
      }
    }
  }
}

/* ---- Create initial game state ---- */
function createAliens(): Alien[] {
  const aliens: Alien[] = [];
  for (let row = 0; row < ALIEN_ROWS; row++) {
    for (let col = 0; col < ALIEN_COLS; col++) {
      aliens.push({ row, col, alive: true });
    }
  }
  return aliens;
}

function createShields(): boolean[][][] {
  const shields: boolean[][][] = [];
  for (let i = 0; i < SHIELD_COUNT; i++) {
    shields.push(createShieldGrid());
  }
  return shields;
}

function getShieldX(index: number): number {
  const totalGap = W - SHIELD_COUNT * SHIELD_W;
  const spacing = totalGap / (SHIELD_COUNT + 1);
  return Math.floor(spacing + index * (SHIELD_W + spacing));
}

function initGameState(level: number = 1): GameState {
  return {
    phase: "playing",
    score: 0,
    lives: 3,
    level,
    playerX: W / 2 - PLAYER_W / 2,
    aliens: createAliens(),
    swarmX: ALIEN_START_X,
    swarmY: ALIEN_GRID_TOP + Math.min(level - 1, 4) * ALIEN_CELL_H, // each level starts 1 row lower
    swarmDir: 1,
    swarmMoveTimer: 0,
    swarmMoveInterval: Math.max(8, 30 - (level - 1) * 3), // frames between swarm steps
    animFrame: 0,
    playerBullet: null,
    alienBullets: [],
    shields: createShields(),
    ufo: { x: 0, dir: 1, active: false, points: 100 },
    ufoTimer: UFO_MIN_INTERVAL + Math.random() * (UFO_MAX_INTERVAL - UFO_MIN_INTERVAL),
    explosions: [],
    dyingTimer: 0,
    keys: new Set(),
  };
}

/* ---- Alien bounds helpers ---- */
function getAliveAlienBounds(aliens: Alien[]): { minCol: number; maxCol: number; minRow: number; maxRow: number } {
  let minCol = ALIEN_COLS, maxCol = -1, minRow = ALIEN_ROWS, maxRow = -1;
  for (const a of aliens) {
    if (!a.alive) continue;
    if (a.col < minCol) minCol = a.col;
    if (a.col > maxCol) maxCol = a.col;
    if (a.row < minRow) minRow = a.row;
    if (a.row > maxRow) maxRow = a.row;
  }
  return { minCol, maxCol, minRow, maxRow };
}

function alienCount(aliens: Alien[]): number {
  return aliens.filter(a => a.alive).length;
}

/* ---- Main component ---- */
export default function SpaceInvadersGame({ onAddHighscore, paused = false }: SpaceInvadersGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);

  const [containerSize, setContainerSize] = useState({ w: 400, h: 600 });
  const [phase, setPhase] = useState<GamePhase>("idle");
  const [displayScore, setDisplayScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [resultSlide, setResultSlide] = useState(0); // 0..1 animation

  const gsRef = useRef<GameState>(initGameState());
  const phaseRef = useRef<GamePhase>("idle");
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const onAddHighscoreRef = useRef(onAddHighscore);
  onAddHighscoreRef.current = onAddHighscore;
  const bestScoreRef = useRef(0);
  const rafRef = useRef(0);
  const prevTimeRef = useRef(0);
  const accumRef = useRef(0);
  const resultSlideRef = useRef(0);

  /* ---- CSS canvas sizing (224:256 aspect) ---- */
  const aspect = W / H;
  const cAspect = containerSize.w / containerSize.h;
  const cssW = cAspect > aspect ? Math.floor(containerSize.h * aspect) : containerSize.w;
  const cssH = cAspect > aspect ? containerSize.h : Math.floor(containerSize.w / aspect);

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

  /* ---- Drawing ---- */
  const draw = useCallback((gs: GameState) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.imageSmoothingEnabled = false;

    // Clear
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    // Score area
    drawPixelText(ctx, "SCORE", 4, 4, C.scoreLabel, 1);
    drawPixelText(ctx, String(gs.score).padStart(6, "0"), 4, 12, C.text, 1);
    drawPixelText(ctx, "HI", W - 44, 4, C.scoreLabel, 1);
    drawPixelText(ctx, String(Math.max(gs.score, bestScoreRef.current)).padStart(6, "0"), W - 44, 12, C.text, 1);

    // Level indicator
    drawPixelText(ctx, "LV" + gs.level, W / 2 - 8, 4, C.textDim, 1);

    // Separator line
    ctx.fillStyle = C.scoreLabel;
    ctx.fillRect(0, 22, W, 1);

    // Shields
    for (let si = 0; si < SHIELD_COUNT; si++) {
      const sx = getShieldX(si);
      const shield = gs.shields[si];
      ctx.fillStyle = C.shield;
      for (let y = 0; y < SHIELD_H; y++) {
        for (let x = 0; x < SHIELD_W; x++) {
          if (shield[y][x]) {
            ctx.fillRect(sx + x, SHIELD_Y + y, 1, 1);
          }
        }
      }
    }

    // Aliens
    const aliveCount = alienCount(gs.aliens);
    for (const alien of gs.aliens) {
      if (!alien.alive) continue;
      const ax = gs.swarmX + alien.col * ALIEN_CELL_W;
      const ay = gs.swarmY + alien.row * ALIEN_CELL_H;

      let spriteA: number[][], spriteB: number[][];
      let color: string;

      if (alien.row === 0) {
        // Bottom row — large aliens
        spriteA = SPRITE_LARGE_A;
        spriteB = SPRITE_LARGE_B;
        color = C.alien3;
      } else if (alien.row <= 2) {
        // Middle rows — medium aliens
        spriteA = SPRITE_MED_A;
        spriteB = SPRITE_MED_B;
        color = C.alien2;
      } else {
        // Top rows — small aliens
        spriteA = SPRITE_SMALL_A;
        spriteB = SPRITE_SMALL_B;
        color = C.alien1;
      }

      const sprite = gs.animFrame % 2 === 0 ? spriteA : spriteB;
      const spriteW = sprite[0].length;
      const ox = Math.floor((ALIEN_CELL_W - spriteW) / 2);
      drawSprite(ctx, sprite, ax + ox, ay + 4, color);
    }

    // Player ship
    if (gs.phase !== "dying" || Math.floor(gs.dyingTimer * 8) % 2 === 0) {
      drawSprite(ctx, SPRITE_PLAYER, gs.playerX, PLAYER_Y, C.player);
      // Highlight top of cannon
      ctx.fillStyle = C.playerHi;
      ctx.fillRect(gs.playerX + 6, PLAYER_Y, 1, 1);
    }

    // Player bullet
    if (gs.playerBullet) {
      ctx.fillStyle = C.bullet;
      ctx.fillRect(gs.playerBullet.x, gs.playerBullet.y, 1, 4);
    }

    // Alien bullets
    for (const b of gs.alienBullets) {
      ctx.fillStyle = C.alienBullet;
      // Zigzag shape
      const zigFrame = Math.floor(b.y / 4) % 2;
      ctx.fillRect(b.x + (zigFrame ? 1 : 0), b.y, 1, 2);
      ctx.fillRect(b.x + (zigFrame ? 0 : 1), b.y + 2, 1, 2);
    }

    // UFO
    if (gs.ufo.active) {
      drawSprite(ctx, SPRITE_UFO, gs.ufo.x, 26, C.ufo);
      // Pulsing highlight on dome
      const pulse = Math.sin(performance.now() * 0.01) * 0.3 + 0.7;
      ctx.globalAlpha = pulse;
      ctx.fillStyle = C.ufoHi;
      ctx.fillRect(gs.ufo.x + 5, 26, 6, 1);
      ctx.globalAlpha = 1;
    }

    // Explosions
    for (const ex of gs.explosions) {
      if (ex.text) {
        drawPixelText(ctx, ex.text, ex.x, ex.y, C.explosion, 1);
      } else {
        const alpha = Math.max(0, ex.timer / 10);
        ctx.globalAlpha = alpha;
        drawSprite(ctx, SPRITE_EXPLODE, ex.x - 6, ex.y - 4, C.explosion);
        ctx.globalAlpha = 1;
      }
    }

    // Lives display (bottom left)
    ctx.fillStyle = C.scoreLabel;
    ctx.fillRect(0, H - 1, W, 1); // bottom line
    drawPixelText(ctx, String(gs.lives), 4, H - 9, C.text, 1);
    for (let i = 0; i < gs.lives - 1; i++) {
      drawSprite(ctx, SPRITE_PLAYER, 18 + i * 16, H - 10, C.player);
    }

    // Wave cleared text (brief flash)
    if (aliveCount === 0 && gs.phase === "playing") {
      const tw = textPixelWidth("WAVE CLEARED", 1);
      drawPixelText(ctx, "WAVE CLEARED", Math.floor((W - tw) / 2), H / 2 - 4, C.text, 1);
    }
  }, []);

  /* ---- Game logic update (one fixed timestep) ---- */
  const update = useCallback((gs: GameState, dtMs: number) => {
    if (gs.phase === "dying") {
      gs.dyingTimer -= dtMs / 1000;
      // Update explosions during death
      gs.explosions = gs.explosions.filter(e => { e.timer--; return e.timer > 0; });
      if (gs.dyingTimer <= 0) {
        if (gs.lives <= 0) {
          gs.phase = "over";
          phaseRef.current = "over";
          setPhase("over");
          setDisplayScore(gs.score);
          if (gs.score > bestScoreRef.current) {
            bestScoreRef.current = gs.score;
            setBestScore(gs.score);
          }
          onAddHighscoreRef.current(gs.score);
          resultSlideRef.current = 0;
        } else {
          // Respawn
          gs.phase = "playing";
          phaseRef.current = "playing";
          setPhase("playing");
          gs.playerX = W / 2 - PLAYER_W / 2;
          gs.playerBullet = null;
          gs.alienBullets = [];
        }
      }
      return;
    }

    if (gs.phase !== "playing") return;

    // --- Player movement ---
    if (gs.keys.has("ArrowLeft") || gs.keys.has("a") || gs.keys.has("A")) {
      gs.playerX = Math.max(2, gs.playerX - PLAYER_SPEED);
    }
    if (gs.keys.has("ArrowRight") || gs.keys.has("d") || gs.keys.has("D")) {
      gs.playerX = Math.min(W - PLAYER_W - 2, gs.playerX + PLAYER_SPEED);
    }

    // --- Player shooting ---
    if ((gs.keys.has(" ") || gs.keys.has("ArrowUp") || gs.keys.has("w") || gs.keys.has("W")) && !gs.playerBullet) {
      gs.playerBullet = { x: gs.playerX + Math.floor(PLAYER_W / 2), y: PLAYER_Y - 2, dy: -PLAYER_BULLET_SPEED };
    }

    // --- Move player bullet ---
    if (gs.playerBullet) {
      gs.playerBullet.y += gs.playerBullet.dy;
      if (gs.playerBullet.y < 22) {
        gs.playerBullet = null;
      }
    }

    // --- Alien swarm movement ---
    gs.swarmMoveTimer++;
    // Speed increases as fewer aliens remain
    const alive = alienCount(gs.aliens);
    const speedMult = alive <= 1 ? 1 : alive <= 4 ? 2 : alive <= 10 ? Math.floor(gs.swarmMoveInterval * 0.4) : gs.swarmMoveInterval;
    const effectiveInterval = alive <= 1 ? 1 : alive <= 4 ? 2 : Math.max(2, speedMult);

    if (gs.swarmMoveTimer >= effectiveInterval) {
      gs.swarmMoveTimer = 0;
      gs.animFrame++;

      const bounds = getAliveAlienBounds(gs.aliens);
      const leftEdge = gs.swarmX + bounds.minCol * ALIEN_CELL_W;
      const rightEdge = gs.swarmX + (bounds.maxCol + 1) * ALIEN_CELL_W;

      let dropDown = false;
      if (gs.swarmDir === 1 && rightEdge >= W - 4) {
        dropDown = true;
      } else if (gs.swarmDir === -1 && leftEdge <= 4) {
        dropDown = true;
      }

      if (dropDown) {
        gs.swarmY += 8;
        gs.swarmDir *= -1;
      } else {
        gs.swarmX += gs.swarmDir * 2;
      }

      // Check if aliens reached player level
      const bottomEdge = gs.swarmY + (bounds.maxRow + 1) * ALIEN_CELL_H;
      if (bottomEdge >= PLAYER_Y - 4) {
        // Instant game over
        gs.lives = 0;
        gs.phase = "dying";
        phaseRef.current = "dying";
        setPhase("dying");
        gs.dyingTimer = 1.5;
        gs.explosions.push({ x: gs.playerX + PLAYER_W / 2, y: PLAYER_Y, timer: 15 });
        return;
      }
    }

    // --- Alien shooting ---
    const maxBullets = alive <= 5 ? 1 : alive <= 20 ? 2 : 3;
    if (gs.alienBullets.length < maxBullets && Math.random() < 0.03) {
      // Pick a random alive alien from the bottom of each column
      const bottomAliens: Alien[] = [];
      for (let col = 0; col < ALIEN_COLS; col++) {
        let bottom: Alien | null = null;
        for (const a of gs.aliens) {
          if (a.alive && a.col === col) {
            if (!bottom || a.row < bottom.row) bottom = a;
          }
        }
        if (bottom) bottomAliens.push(bottom);
      }
      if (bottomAliens.length > 0) {
        const shooter = bottomAliens[Math.floor(Math.random() * bottomAliens.length)];
        const bx = gs.swarmX + shooter.col * ALIEN_CELL_W + Math.floor(ALIEN_CELL_W / 2);
        const by = gs.swarmY + shooter.row * ALIEN_CELL_H + ALIEN_CELL_H;
        gs.alienBullets.push({ x: bx, y: by, dy: ALIEN_BULLET_SPEED });
      }
    }

    // --- Move alien bullets ---
    gs.alienBullets = gs.alienBullets.filter(b => {
      b.y += b.dy;
      return b.y < H - 4;
    });

    // --- Player bullet vs aliens collision ---
    if (gs.playerBullet) {
      const bx = gs.playerBullet.x;
      const by = gs.playerBullet.y;
      for (const alien of gs.aliens) {
        if (!alien.alive) continue;
        const ax = gs.swarmX + alien.col * ALIEN_CELL_W;
        const ay = gs.swarmY + alien.row * ALIEN_CELL_H + 4;
        const aw = ALIEN_CELL_W - 2;
        const ah = 8;
        if (bx >= ax && bx < ax + aw && by >= ay && by < ay + ah) {
          alien.alive = false;
          gs.playerBullet = null;
          // Score — row 0 is bottom (large), row 4 is top (small)
          const pts = ALIEN_POINTS[alien.row];
          gs.score += pts;
          setDisplayScore(gs.score);
          gs.explosions.push({ x: ax + aw / 2, y: ay, timer: 8, text: String(pts) });
          break;
        }
      }
    }

    // --- Player bullet vs UFO ---
    if (gs.playerBullet && gs.ufo.active) {
      const bx = gs.playerBullet.x;
      const by = gs.playerBullet.y;
      if (bx >= gs.ufo.x && bx < gs.ufo.x + UFO_W && by >= 26 && by < 26 + UFO_H) {
        gs.ufo.active = false;
        gs.playerBullet = null;
        const pts = gs.ufo.points;
        gs.score += pts;
        setDisplayScore(gs.score);
        gs.explosions.push({ x: gs.ufo.x + UFO_W / 2, y: 26, timer: 20, text: String(pts) });
      }
    }

    // --- Player bullet vs shields ---
    if (gs.playerBullet) {
      const bx = gs.playerBullet.x;
      const by = gs.playerBullet.y;
      for (let si = 0; si < SHIELD_COUNT; si++) {
        const sx = getShieldX(si);
        const localX = bx - sx;
        const localY = by - SHIELD_Y;
        if (localX >= 0 && localX < SHIELD_W && localY >= 0 && localY < SHIELD_H) {
          if (gs.shields[si][localY][localX]) {
            // Erode a small area
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const ey = localY + dy;
                const ex = localX + dx;
                if (ey >= 0 && ey < SHIELD_H && ex >= 0 && ex < SHIELD_W) {
                  gs.shields[si][ey][ex] = false;
                }
              }
            }
            gs.playerBullet = null;
            break;
          }
        }
      }
    }

    // --- Alien bullets vs shields ---
    gs.alienBullets = gs.alienBullets.filter(b => {
      for (let si = 0; si < SHIELD_COUNT; si++) {
        const sx = getShieldX(si);
        const localX = Math.floor(b.x - sx);
        const localY = Math.floor(b.y - SHIELD_Y);
        if (localX >= 0 && localX < SHIELD_W && localY >= 0 && localY < SHIELD_H) {
          if (gs.shields[si][localY][localX]) {
            for (let dy = -1; dy <= 2; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const ey = localY + dy;
                const ex = localX + dx;
                if (ey >= 0 && ey < SHIELD_H && ex >= 0 && ex < SHIELD_W) {
                  gs.shields[si][ey][ex] = false;
                }
              }
            }
            return false;
          }
        }
      }
      return true;
    });

    // --- Alien bullets vs player ---
    for (const b of gs.alienBullets) {
      if (b.x >= gs.playerX && b.x < gs.playerX + PLAYER_W &&
          b.y >= PLAYER_Y && b.y < PLAYER_Y + PLAYER_H) {
        gs.lives--;
        gs.phase = "dying";
        phaseRef.current = "dying";
        setPhase("dying");
        gs.dyingTimer = 1.5;
        gs.alienBullets = [];
        gs.playerBullet = null;
        gs.explosions.push({ x: gs.playerX + PLAYER_W / 2, y: PLAYER_Y, timer: 15 });
        return;
      }
    }

    // --- Alien body vs shields (erode from above) ---
    for (const alien of gs.aliens) {
      if (!alien.alive) continue;
      const ax = gs.swarmX + alien.col * ALIEN_CELL_W;
      const ay = gs.swarmY + alien.row * ALIEN_CELL_H + 4;
      const aw = ALIEN_CELL_W - 2;
      const ah = 8;
      for (let si = 0; si < SHIELD_COUNT; si++) {
        const sx = getShieldX(si);
        // Check overlap
        if (ax + aw > sx && ax < sx + SHIELD_W && ay + ah > SHIELD_Y && ay < SHIELD_Y + SHIELD_H) {
          for (let py = 0; py < SHIELD_H; py++) {
            for (let px = 0; px < SHIELD_W; px++) {
              const worldX = sx + px;
              const worldY = SHIELD_Y + py;
              if (worldX >= ax && worldX < ax + aw && worldY >= ay && worldY < ay + ah) {
                gs.shields[si][py][px] = false;
              }
            }
          }
        }
      }
    }

    // --- UFO logic ---
    if (gs.ufo.active) {
      gs.ufo.x += UFO_SPEED * gs.ufo.dir;
      if (gs.ufo.x < -UFO_W || gs.ufo.x > W + UFO_W) {
        gs.ufo.active = false;
        gs.ufoTimer = UFO_MIN_INTERVAL + Math.random() * (UFO_MAX_INTERVAL - UFO_MIN_INTERVAL);
      }
    } else {
      gs.ufoTimer -= FRAME_MS;
      if (gs.ufoTimer <= 0 && alive > 4) {
        const dir = Math.random() < 0.5 ? 1 : -1;
        gs.ufo = {
          x: dir === 1 ? -UFO_W : W + UFO_W,
          dir,
          active: true,
          points: UFO_POINTS[Math.floor(Math.random() * UFO_POINTS.length)],
        };
      }
    }

    // --- Explosions decay ---
    gs.explosions = gs.explosions.filter(e => { e.timer--; return e.timer > 0; });

    // --- Check wave cleared ---
    if (alive === 0) {
      // Start next level after short delay
      const nextLevel = gs.level + 1;
      const prevScore = gs.score;
      const prevLives = gs.lives;
      Object.assign(gs, initGameState(nextLevel));
      gs.score = prevScore;
      gs.lives = prevLives;
      gs.level = nextLevel;
      setDisplayScore(gs.score);
    }
  }, []);

  /* ---- Start game ---- */
  const startGame = useCallback(() => {
    const gs = initGameState(1);
    gsRef.current = gs;
    phaseRef.current = "playing";
    setPhase("playing");
    setDisplayScore(0);
    resultSlideRef.current = 0;
    setResultSlide(0);
    prevTimeRef.current = 0;
    accumRef.current = 0;
  }, []);

  /* ---- Game loop ---- */
  useEffect(() => {
    if (phase === "idle") {
      // Draw idle screen
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.imageSmoothingEnabled = false;
          ctx.fillStyle = C.bg;
          ctx.fillRect(0, 0, W, H);

          // Title
          const title = "SPACE INVADERS";
          const tw = textPixelWidth(title, 2);
          drawPixelText(ctx, title, Math.floor((W - tw) / 2), 40, C.text, 2);

          // Show alien types and points
          drawSprite(ctx, SPRITE_SMALL_A, 60, 90, C.alien1);
          drawPixelText(ctx, "30 PTS", 85, 92, C.text, 1);
          drawSprite(ctx, SPRITE_MED_A, 59, 108, C.alien2);
          drawPixelText(ctx, "20 PTS", 85, 110, C.text, 1);
          drawSprite(ctx, SPRITE_LARGE_A, 58, 126, C.alien3);
          drawPixelText(ctx, "10 PTS", 85, 128, C.text, 1);
          drawSprite(ctx, SPRITE_UFO, 55, 144, C.ufo);
          drawPixelText(ctx, "50-300", 85, 146, C.text, 1);

          // Controls
          const ctrl1 = "ARROWS OR WASD";
          drawPixelText(ctx, ctrl1, Math.floor((W - textPixelWidth(ctrl1, 1)) / 2), 180, C.textDim, 1);
          const ctrl2 = "SPACE TO SHOOT";
          drawPixelText(ctx, ctrl2, Math.floor((W - textPixelWidth(ctrl2, 1)) / 2), 192, C.textDim, 1);

          // Start prompt
          const start = "PRESS SPACE";
          const sw = textPixelWidth(start, 1);
          drawPixelText(ctx, start, Math.floor((W - sw) / 2), 220, C.scoreLabel, 1);
        }
      }
      return;
    }

    const loop = (time: number) => {
      if (prevTimeRef.current === 0) prevTimeRef.current = time;
      const dt = Math.min(time - prevTimeRef.current, 100); // cap to prevent spiral
      prevTimeRef.current = time;

      const gs = gsRef.current;

      if (gs.phase === "over") {
        // Animate result slide-in
        if (resultSlideRef.current < 1) {
          resultSlideRef.current = Math.min(1, resultSlideRef.current + 0.04);
          setResultSlide(resultSlideRef.current);
        }
        draw(gs);
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      if (pausedRef.current) {
        draw(gs);
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      accumRef.current += dt;

      while (accumRef.current >= FRAME_MS) {
        accumRef.current -= FRAME_MS;
        update(gs, FRAME_MS);
      }

      draw(gs);
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, draw, update]);

  /* ---- Keyboard handlers ---- */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const gs = gsRef.current;

      // Prevent scrolling
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }

      if (phaseRef.current === "idle" && e.key === " ") {
        startGame();
        return;
      }

      if (phaseRef.current === "over" && e.key === " ") {
        startGame();
        return;
      }

      if (phaseRef.current === "playing" || phaseRef.current === "dying") {
        gs.keys.add(e.key);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const gs = gsRef.current;
      gs.keys.delete(e.key);
    };

    const handleBlur = () => {
      gsRef.current.keys.clear();
    };

    container.addEventListener("keydown", handleKeyDown);
    container.addEventListener("keyup", handleKeyUp);
    container.addEventListener("blur", handleBlur);
    return () => {
      container.removeEventListener("keydown", handleKeyDown);
      container.removeEventListener("keyup", handleKeyUp);
      container.removeEventListener("blur", handleBlur);
    };
  }, [startGame]);

  /* ---- Auto-focus ---- */
  useEffect(() => { containerRef.current?.focus(); }, [phase]);

  /* ---- Render ---- */
  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        outline: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: C.bg,
        overflow: "hidden",
      }}
    >
      <div
        ref={canvasAreaRef}
        style={{
          flex: 1, position: "relative", overflow: "hidden",
          display: "flex", alignItems: "center", justifyContent: "center",
          width: "100%",
        }}
      >
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          style={{
            display: "block",
            width: cssW,
            height: cssH,
            imageRendering: "pixelated",
          }}
        />
      </div>

      {/* Pause overlay */}
      {paused && (phase === "playing" || phase === "dying") && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0, 0, 0, 0.6)",
            zIndex: 10,
          }}
        >
          <div style={{
            fontFamily: "monospace",
            fontSize: 24,
            fontWeight: 700,
            color: C.text,
            letterSpacing: 8,
            textShadow: `0 0 12px ${C.scoreLabel}`,
          }}>
            PAUSED
          </div>
        </div>
      )}

      {/* Results panel — slides up from bottom on game over */}
      {phase === "over" && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            transform: `translateY(${(1 - resultSlide) * 100}%)`,
            transition: "none",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            padding: "16px 12px 20px",
            background: "linear-gradient(transparent, rgba(0,0,0,0.95) 20%)",
            zIndex: 20,
          }}
        >
          <div style={{
            fontFamily: "monospace",
            fontSize: 18,
            fontWeight: 700,
            color: "#ff4444",
            letterSpacing: 4,
          }}>
            GAME OVER
          </div>
          <div style={{
            fontFamily: "monospace",
            fontSize: 14,
            color: C.text,
            fontVariantNumeric: "tabular-nums",
          }}>
            SCORE: {displayScore}
          </div>
          {displayScore > 0 && displayScore >= bestScore && (
            <div style={{
              fontFamily: "monospace",
              fontSize: 11,
              color: C.scoreLabel,
              fontWeight: 600,
            }}>
              NEW HIGH SCORE!
            </div>
          )}
          <div style={{
            fontFamily: "monospace",
            fontSize: 10,
            color: C.textDim,
            marginTop: 4,
          }}>
            SPACE TO RETRY
          </div>
        </div>
      )}
    </div>
  );
}

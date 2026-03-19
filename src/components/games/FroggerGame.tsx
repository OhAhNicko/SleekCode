import { useRef, useEffect, useState, useCallback } from "react";

interface FroggerGameProps {
  onAddHighscore: (score: number) => void;
  paused?: boolean;
}

type GamePhase = "idle" | "playing" | "dying" | "over";
type DeathType = "road" | "water" | "time" | "edge";

/* ---- Frogger constants (224×256 native, 30 fps) ---- */
const W = 224;
const H = 256;
const CELL = 16;
const COLS = W / CELL;     // 14
// Grid: 14 cols x 16 rows
const FRAME_MS = 1000 / 30;

const FROG_START_COL = 7;
const FROG_START_ROW = 14; // bottom safe zone (row 14 of 0-15)
const HOP_FRAMES = 6;      // smooth slide over 6 frames
const HOP_COOLDOWN = 3;    // frames after hop before next hop allowed
const TIMER_SECONDS = 30;
const TIMER_FRAMES = TIMER_SECONDS * 30;
const LIVES_START = 3;
const HOME_SLOTS = 5;

/* ---- Scoring ---- */
const PTS_HOP = 10;
const PTS_PAD = 50;
const PTS_ALL_PADS = 1000;

/* ---- Colors ---- */
const C = {
  // Frog
  frogBody: "#44cc44", frogDk: "#228822", frogEye: "#ffffff", frogPupil: "#111111",
  frogDead: "#cc2222",
  // Road
  road: "#444444", roadLine: "#cccccc", roadEdge: "#555555",
  // Vehicles
  car1: "#dd3333", car1Dk: "#aa2222", car1Win: "#88ccff",
  car2: "#dddd33", car2Dk: "#aaaa22", car2Win: "#88ccff",
  car3: "#3355dd", car3Dk: "#2244aa", car3Win: "#88ccff",
  truck: "#eeeeee", truckDk: "#bbbbbb", truckCab: "#cc6622",
  truckCabDk: "#993311",
  // Water
  water: "#2244aa", waterHi: "#3366cc", waterDk: "#112266",
  // Logs
  log: "#885522", logHi: "#aa7733", logDk: "#663311", logEnd: "#774411",
  // Turtles
  turtle: "#228844", turtleDk: "#116633", turtleShell: "#33aa55",
  turtleDive: "#334488",
  // Grass / safe zones
  grass: "#226622", grassHi: "#338833", grassDk: "#114411",
  // Lily pads / home
  homeZone: "#113311", padFill: "#33aa44", padOccupied: "#44cc44",
  padOutline: "#228833",
  // UI
  text: "#ffffff", textSh: "#000000",
  timerFull: "#44cc44", timerMid: "#cccc44", timerLow: "#cc3333",
  lifeFrog: "#44cc44",
};

/* ---- Lane definitions ---- */
// direction: -1 = left, 1 = right
// objType: "car1"|"car2"|"car3"|"truck" for road, "log"|"turtle" for river
interface LaneDef {
  row: number;
  type: "road" | "river";
  dir: number;
  baseSpeed: number;
  objType: string;
  objLen: number;    // cells
  gap: number;       // cells between objects
  count: number;     // number of objects in lane
}

const LANE_DEFS: LaneDef[] = [
  // Road lanes (rows 10-13, bottom to top from frog start)
  { row: 13, type: "road", dir: -1, baseSpeed: 0.8, objType: "car1",  objLen: 1, gap: 4, count: 3 },
  { row: 12, type: "road", dir:  1, baseSpeed: 1.2, objType: "truck", objLen: 3, gap: 5, count: 2 },
  { row: 11, type: "road", dir: -1, baseSpeed: 1.5, objType: "car2",  objLen: 1, gap: 3, count: 4 },
  { row: 10, type: "road", dir:  1, baseSpeed: 0.9, objType: "car3",  objLen: 1, gap: 4, count: 3 },
  { row:  9, type: "road", dir: -1, baseSpeed: 1.8, objType: "truck", objLen: 2, gap: 5, count: 2 },
  // River lanes (rows 3-7)
  { row:  7, type: "river", dir:  1, baseSpeed: 0.7, objType: "log",    objLen: 3, gap: 4, count: 3 },
  { row:  6, type: "river", dir: -1, baseSpeed: 1.0, objType: "turtle", objLen: 2, gap: 3, count: 4 },
  { row:  5, type: "river", dir:  1, baseSpeed: 1.3, objType: "log",    objLen: 4, gap: 5, count: 2 },
  { row:  4, type: "river", dir: -1, baseSpeed: 0.6, objType: "turtle", objLen: 3, gap: 4, count: 3 },
  { row:  3, type: "river", dir:  1, baseSpeed: 1.1, objType: "log",    objLen: 2, gap: 3, count: 4 },
];

/* ---- Lane object runtime data ---- */
interface LaneObj {
  x: number;       // pixel x position
  len: number;     // width in pixels
  diveTimer: number;  // for turtles: frames until dive toggle
  diving: boolean;    // for turtles: currently underwater
}

interface Lane {
  def: LaneDef;
  objects: LaneObj[];
  speed: number;    // current speed (increases with level)
}

/* ---- Home pad slot positions ---- */
function getHomePadX(slot: number): number {
  // 5 pads evenly distributed across the width
  // slots at columns 1, 4, 7, 10, 13 (0-indexed)
  const positions = [1, 4, 7, 10, 13];
  return positions[slot] * CELL;
}

/* ---- Helper: create lane objects ---- */
function createLaneObjects(def: LaneDef): LaneObj[] {
  const objs: LaneObj[] = [];
  const spacing = (def.objLen + def.gap) * CELL;
  for (let i = 0; i < def.count; i++) {
    // For left-moving lanes, spread objects starting from the right edge
    // so they enter from the right border naturally
    const x = def.dir < 0
      ? W + i * spacing
      : i * spacing;
    objs.push({
      x,
      len: def.objLen * CELL,
      diveTimer: def.objType === "turtle" ? 120 + Math.floor(Math.random() * 180) : 0,
      diving: false,
    });
  }
  return objs;
}

function createLanes(level: number): Lane[] {
  const speedMult = 1 + (level - 1) * 0.15;
  return LANE_DEFS.map((def) => ({
    def,
    objects: createLaneObjects(def),
    speed: def.baseSpeed * speedMult * def.dir,
  }));
}

/* ---- Pixel-art drawing helpers ---- */
function drawPixelFrog(ctx: CanvasRenderingContext2D, x: number, y: number, dir: string, dead: boolean) {
  const cx = Math.floor(x);
  const cy = Math.floor(y);

  if (dead) {
    // Splat / X shape
    ctx.fillStyle = C.frogDead;
    // X pattern
    for (let i = 0; i < 7; i++) {
      ctx.fillRect(cx + 2 + i * 1.5, cy + 2 + i * 1.5, 2, 2);
      ctx.fillRect(cx + 12 - i * 1.5, cy + 2 + i * 1.5, 2, 2);
    }
    // Outer splat dots
    ctx.fillRect(cx, cy + 6, 2, 2);
    ctx.fillRect(cx + 14, cy + 6, 2, 2);
    ctx.fillRect(cx + 6, cy, 2, 2);
    ctx.fillRect(cx + 6, cy + 14, 2, 2);
    return;
  }

  // Body
  ctx.fillStyle = C.frogBody;
  ctx.fillRect(cx + 3, cy + 2, 10, 12);
  ctx.fillRect(cx + 2, cy + 4, 12, 8);
  ctx.fillRect(cx + 4, cy + 1, 8, 14);

  // Dark accents
  ctx.fillStyle = C.frogDk;
  ctx.fillRect(cx + 5, cy + 3, 6, 2);   // back stripe
  ctx.fillRect(cx + 4, cy + 7, 8, 1);   // mid stripe

  // Legs — extend in movement direction
  ctx.fillStyle = C.frogBody;
  if (dir === "up" || dir === "idle") {
    // Back legs splayed
    ctx.fillRect(cx + 1, cy + 12, 3, 3);
    ctx.fillRect(cx + 12, cy + 12, 3, 3);
    ctx.fillRect(cx + 0, cy + 14, 2, 2);
    ctx.fillRect(cx + 14, cy + 14, 2, 2);
    // Front legs
    ctx.fillRect(cx + 1, cy + 2, 3, 3);
    ctx.fillRect(cx + 12, cy + 2, 3, 3);
  } else if (dir === "down") {
    ctx.fillRect(cx + 1, cy + 0, 3, 3);
    ctx.fillRect(cx + 12, cy + 0, 3, 3);
    ctx.fillRect(cx + 0, cy + 0, 2, 2);
    ctx.fillRect(cx + 14, cy + 0, 2, 2);
    ctx.fillRect(cx + 1, cy + 11, 3, 3);
    ctx.fillRect(cx + 12, cy + 11, 3, 3);
  } else if (dir === "left") {
    ctx.fillRect(cx + 0, cy + 2, 3, 3);
    ctx.fillRect(cx + 0, cy + 11, 3, 3);
    ctx.fillRect(cx + 11, cy + 3, 3, 2);
    ctx.fillRect(cx + 11, cy + 11, 3, 2);
  } else if (dir === "right") {
    ctx.fillRect(cx + 13, cy + 2, 3, 3);
    ctx.fillRect(cx + 13, cy + 11, 3, 3);
    ctx.fillRect(cx + 2, cy + 3, 3, 2);
    ctx.fillRect(cx + 2, cy + 11, 3, 2);
  }

  // Eyes
  ctx.fillStyle = C.frogEye;
  ctx.fillRect(cx + 4, cy + 3, 3, 3);
  ctx.fillRect(cx + 9, cy + 3, 3, 3);
  ctx.fillStyle = C.frogPupil;
  ctx.fillRect(cx + 5, cy + 4, 2, 2);
  ctx.fillRect(cx + 10, cy + 4, 2, 2);
}

function drawWaterDeathRipple(ctx: CanvasRenderingContext2D, x: number, y: number, frame: number) {
  const cx = Math.floor(x) + 8;
  const cy = Math.floor(y) + 8;
  ctx.strokeStyle = C.waterHi;
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const r = 3 + frame * 1.5 + i * 4;
    const alpha = Math.max(0, 1 - (frame + i * 3) / 20);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawCar(ctx: CanvasRenderingContext2D, x: number, y: number, type: string, dir: number) {
  const px = Math.floor(x);
  const py = Math.floor(y);
  let body: string, dk: string, win: string;
  if (type === "car1")      { body = C.car1; dk = C.car1Dk; win = C.car1Win; }
  else if (type === "car2") { body = C.car2; dk = C.car2Dk; win = C.car2Win; }
  else                      { body = C.car3; dk = C.car3Dk; win = C.car3Win; }

  // Car body
  ctx.fillStyle = body;
  ctx.fillRect(px + 1, py + 3, 14, 10);
  ctx.fillRect(px + 2, py + 2, 12, 12);
  // Darker underside
  ctx.fillStyle = dk;
  ctx.fillRect(px + 2, py + 12, 12, 2);
  // Windshield
  ctx.fillStyle = win;
  if (dir > 0) {
    ctx.fillRect(px + 10, py + 4, 3, 5);
  } else {
    ctx.fillRect(px + 3, py + 4, 3, 5);
  }
  // Headlight
  ctx.fillStyle = "#ffff88";
  if (dir > 0) {
    ctx.fillRect(px + 14, py + 5, 2, 2);
    ctx.fillRect(px + 14, py + 9, 2, 2);
  } else {
    ctx.fillRect(px, py + 5, 2, 2);
    ctx.fillRect(px, py + 9, 2, 2);
  }
  // Taillight
  ctx.fillStyle = "#cc2222";
  if (dir > 0) {
    ctx.fillRect(px, py + 6, 1, 4);
  } else {
    ctx.fillRect(px + 15, py + 6, 1, 4);
  }
}

function drawTruck(ctx: CanvasRenderingContext2D, x: number, y: number, len: number, dir: number) {
  const px = Math.floor(x);
  const py = Math.floor(y);
  const w = len;
  // Trailer body
  ctx.fillStyle = C.truck;
  ctx.fillRect(px + 1, py + 2, w - 2, 12);
  ctx.fillRect(px + 2, py + 1, w - 4, 14);
  ctx.fillStyle = C.truckDk;
  ctx.fillRect(px + 2, py + 13, w - 4, 2);
  // Cab (front)
  ctx.fillStyle = C.truckCab;
  if (dir > 0) {
    ctx.fillRect(px + w - 6, py + 2, 6, 12);
    ctx.fillStyle = C.truckCabDk;
    ctx.fillRect(px + w - 6, py + 12, 6, 2);
    ctx.fillStyle = C.car1Win;
    ctx.fillRect(px + w - 4, py + 4, 3, 4);
    ctx.fillStyle = "#ffff88";
    ctx.fillRect(px + w - 1, py + 5, 2, 2);
    ctx.fillRect(px + w - 1, py + 9, 2, 2);
  } else {
    ctx.fillRect(px, py + 2, 6, 12);
    ctx.fillStyle = C.truckCabDk;
    ctx.fillRect(px, py + 12, 6, 2);
    ctx.fillStyle = C.car1Win;
    ctx.fillRect(px + 1, py + 4, 3, 4);
    ctx.fillStyle = "#ffff88";
    ctx.fillRect(px - 1, py + 5, 2, 2);
    ctx.fillRect(px - 1, py + 9, 2, 2);
  }
}

function drawLog(ctx: CanvasRenderingContext2D, x: number, y: number, len: number) {
  const px = Math.floor(x);
  const py = Math.floor(y);
  // Log body
  ctx.fillStyle = C.log;
  ctx.fillRect(px + 1, py + 3, len - 2, 10);
  ctx.fillRect(px + 2, py + 2, len - 4, 12);
  // Highlight
  ctx.fillStyle = C.logHi;
  ctx.fillRect(px + 3, py + 4, len - 6, 3);
  // Dark bark
  ctx.fillStyle = C.logDk;
  ctx.fillRect(px + 3, py + 11, len - 6, 2);
  // End caps
  ctx.fillStyle = C.logEnd;
  ctx.fillRect(px + 1, py + 5, 2, 6);
  ctx.fillRect(px + len - 3, py + 5, 2, 6);
  // Bark rings
  ctx.fillStyle = C.logDk;
  for (let i = CELL; i < len - 4; i += CELL) {
    ctx.fillRect(px + i, py + 3, 1, 10);
  }
}

function drawTurtle(ctx: CanvasRenderingContext2D, x: number, y: number, diving: boolean) {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (diving) {
    // Submerged — just a ripple hint
    ctx.fillStyle = C.turtleDive;
    ctx.fillRect(px + 2, py + 6, 12, 4);
    ctx.fillRect(px + 4, py + 5, 8, 6);
    ctx.fillStyle = C.waterHi;
    ctx.fillRect(px + 4, py + 6, 8, 1);
    return;
  }
  // Shell
  ctx.fillStyle = C.turtleShell;
  ctx.fillRect(px + 3, py + 3, 10, 10);
  ctx.fillRect(px + 4, py + 2, 8, 12);
  // Dark shell pattern
  ctx.fillStyle = C.turtleDk;
  ctx.fillRect(px + 6, py + 3, 4, 10);
  ctx.fillRect(px + 4, py + 6, 8, 4);
  // Head
  ctx.fillStyle = C.turtle;
  ctx.fillRect(px + 6, py + 1, 4, 3);
  // Flippers
  ctx.fillRect(px + 2, py + 4, 3, 3);
  ctx.fillRect(px + 11, py + 4, 3, 3);
  ctx.fillRect(px + 2, py + 9, 3, 3);
  ctx.fillRect(px + 11, py + 9, 3, 3);
  // Eyes
  ctx.fillStyle = C.frogEye;
  ctx.fillRect(px + 6, py + 1, 1, 1);
  ctx.fillRect(px + 9, py + 1, 1, 1);
}

function drawGrassRow(ctx: CanvasRenderingContext2D, y: number) {
  const py = Math.floor(y);
  ctx.fillStyle = C.grass;
  ctx.fillRect(0, py, W, CELL);
  // Grass texture
  ctx.fillStyle = C.grassHi;
  for (let gx = 0; gx < W; gx += 6) {
    ctx.fillRect(gx, py + 2, 2, 3);
    ctx.fillRect(gx + 3, py + 8, 2, 4);
  }
  ctx.fillStyle = C.grassDk;
  for (let gx = 2; gx < W; gx += 8) {
    ctx.fillRect(gx, py + 5, 1, 2);
    ctx.fillRect(gx + 4, py + 11, 1, 3);
  }
}

function drawHomeRow(ctx: CanvasRenderingContext2D, y: number, filledPads: boolean[]) {
  const py = Math.floor(y);
  // Dark hedge background
  ctx.fillStyle = C.homeZone;
  ctx.fillRect(0, py, W, CELL);

  // Hedge texture
  ctx.fillStyle = C.grassDk;
  for (let gx = 0; gx < W; gx += 4) {
    ctx.fillRect(gx, py + 1, 3, 3);
    ctx.fillRect(gx + 2, py + 7, 3, 3);
  }
  ctx.fillStyle = "#0a2a0a";
  for (let gx = 1; gx < W; gx += 6) {
    ctx.fillRect(gx, py + 4, 2, 4);
    ctx.fillRect(gx + 3, py + 10, 2, 3);
  }

  // Draw lily pad slots
  for (let i = 0; i < HOME_SLOTS; i++) {
    const padX = getHomePadX(i);
    if (filledPads[i]) {
      // Filled — show frog sitting there
      ctx.fillStyle = C.padOccupied;
      ctx.fillRect(padX + 2, py + 2, 12, 12);
      ctx.fillRect(padX + 3, py + 1, 10, 14);
      // Small frog icon
      ctx.fillStyle = C.frogDk;
      ctx.fillRect(padX + 5, py + 4, 6, 8);
      ctx.fillRect(padX + 6, py + 3, 4, 10);
      ctx.fillStyle = C.frogEye;
      ctx.fillRect(padX + 6, py + 5, 1, 1);
      ctx.fillRect(padX + 9, py + 5, 1, 1);
    } else {
      // Open slot — lily pad outline
      ctx.fillStyle = C.padFill;
      ctx.fillRect(padX + 3, py + 4, 10, 8);
      ctx.fillRect(padX + 4, py + 3, 8, 10);
      ctx.fillStyle = C.padOutline;
      ctx.fillRect(padX + 4, py + 3, 8, 1);
      ctx.fillRect(padX + 3, py + 4, 1, 8);
      ctx.fillRect(padX + 4, py + 12, 8, 1);
      ctx.fillRect(padX + 12, py + 4, 1, 8);
      // Pad notch
      ctx.fillStyle = C.water;
      ctx.fillRect(padX + 7, py + 3, 2, 4);
    }
  }
}

/* ---- Component ---- */

export default function FroggerGame({ onAddHighscore, paused = false }: FroggerGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);

  const [containerSize, setContainerSize] = useState({ w: 400, h: 500 });
  const [phase, setPhase] = useState<GamePhase>("idle");
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [showResults, setShowResults] = useState(false);
  const [displayLives, setDisplayLives] = useState(LIVES_START);
  const [displayLevel, setDisplayLevel] = useState(1);
  const [displayFrogs, setDisplayFrogs] = useState(0);

  const phaseRef = useRef<GamePhase>("idle");
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Frog state
  const frogCol = useRef(FROG_START_COL);
  const frogRow = useRef(FROG_START_ROW);
  const frogPxX = useRef(FROG_START_COL * CELL);
  const frogPxY = useRef(FROG_START_ROW * CELL);
  const frogTargetX = useRef(FROG_START_COL * CELL);
  const frogTargetY = useRef(FROG_START_ROW * CELL);
  const frogHopFrame = useRef(0);
  const frogHopping = useRef(false);
  const frogDir = useRef("up");
  const frogCooldown = useRef(0);
  const highestRow = useRef(FROG_START_ROW);

  // Game state
  const lanesRef = useRef<Lane[]>([]);
  const livesRef = useRef(LIVES_START);
  const levelRef = useRef(1);
  const scoreRef = useRef(0);
  const bestRef = useRef(0);
  const timerRef = useRef(TIMER_FRAMES);
  const filledPadsRef = useRef<boolean[]>([false, false, false, false, false]);
  const frogsHomeRef = useRef(0);

  // Death animation
  const deathTypeRef = useRef<DeathType>("road");
  const deathFrameRef = useRef(0);
  const deathDuration = 30; // frames
  const flashFramesRef = useRef(0);

  // Loop state
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const accumRef = useRef(0);

  // Input queue
  const inputQueueRef = useRef<string[]>([]);

  // Idle anim
  const idleTickRef = useRef(0);

  // CSS canvas sizing (7:8 aspect)
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

  // Canvas init
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = W;
    c.height = H;
  }, []);

  const resetFrog = useCallback(() => {
    frogCol.current = FROG_START_COL;
    frogRow.current = FROG_START_ROW;
    frogPxX.current = FROG_START_COL * CELL;
    frogPxY.current = FROG_START_ROW * CELL;
    frogTargetX.current = FROG_START_COL * CELL;
    frogTargetY.current = FROG_START_ROW * CELL;
    frogHopFrame.current = 0;
    frogHopping.current = false;
    frogDir.current = "up";
    frogCooldown.current = 0;
    highestRow.current = FROG_START_ROW;
    timerRef.current = TIMER_FRAMES;
  }, []);

  const initGame = useCallback(() => {
    resetFrog();
    lanesRef.current = createLanes(1);
    livesRef.current = LIVES_START;
    levelRef.current = 1;
    scoreRef.current = 0;
    timerRef.current = TIMER_FRAMES;
    filledPadsRef.current = [false, false, false, false, false];
    frogsHomeRef.current = 0;
    accumRef.current = 0;
    lastTimeRef.current = 0;
    flashFramesRef.current = 0;
    deathFrameRef.current = 0;
    inputQueueRef.current = [];
    setScore(0);
    setDisplayLives(LIVES_START);
    setDisplayLevel(1);
    setDisplayFrogs(0);
    setShowResults(false);
    phaseRef.current = "playing";
    setPhase("playing");
  }, [resetFrog]);

  const startDying = useCallback((dtype: DeathType) => {
    if (phaseRef.current === "dying") return;
    phaseRef.current = "dying";
    setPhase("dying");
    deathTypeRef.current = dtype;
    deathFrameRef.current = 0;
    flashFramesRef.current = 6;
    frogHopping.current = false;
    lastTimeRef.current = 0;
    accumRef.current = 0;
    inputQueueRef.current = [];
  }, []);

  const finishDeath = useCallback(() => {
    livesRef.current--;
    setDisplayLives(livesRef.current);
    if (livesRef.current <= 0) {
      phaseRef.current = "over";
      setPhase("over");
      const s = scoreRef.current;
      if (s > 0) onAddHighscore(s);
      if (s > bestRef.current) { bestRef.current = s; setBestScore(s); }
    } else {
      // Respawn
      resetFrog();
      phaseRef.current = "playing";
      setPhase("playing");
      lastTimeRef.current = 0;
      accumRef.current = 0;
    }
  }, [onAddHighscore, resetFrog]);

  const advanceLevel = useCallback(() => {
    levelRef.current++;
    setDisplayLevel(levelRef.current);
    filledPadsRef.current = [false, false, false, false, false];
    frogsHomeRef.current = 0;
    setDisplayFrogs(0);
    lanesRef.current = createLanes(levelRef.current);
    resetFrog();
    // Level clear bonus
    scoreRef.current += PTS_ALL_PADS;
    setScore(scoreRef.current);
  }, [resetFrog]);

  /* ---- Draw function ---- */
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    // Clear
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, W, H);

    // Row 0-1: score/UI header area
    ctx.fillStyle = "#111111";
    ctx.fillRect(0, 0, W, CELL * 2);

    // Row 2: home row (lily pads)
    drawHomeRow(ctx, 2 * CELL, filledPadsRef.current);

    // Rows 3-7: river
    for (let r = 3; r <= 7; r++) {
      ctx.fillStyle = C.water;
      ctx.fillRect(0, r * CELL, W, CELL);
      // Water shimmer
      ctx.fillStyle = C.waterHi;
      const shimOffset = (r * 7 + Math.floor(idleTickRef.current * 0.3)) % 12;
      for (let sx = -shimOffset; sx < W; sx += 12) {
        ctx.fillRect(sx, r * CELL + 4, 4, 1);
        ctx.fillRect(sx + 6, r * CELL + 10, 3, 1);
      }
    }

    // Draw river objects (behind frog)
    for (const lane of lanesRef.current) {
      if (lane.def.type !== "river") continue;
      const ly = lane.def.row * CELL;
      for (const obj of lane.objects) {
        if (obj.x + obj.len < 0 || obj.x > W) continue;
        if (lane.def.objType === "log") {
          drawLog(ctx, obj.x, ly, obj.len);
        } else if (lane.def.objType === "turtle") {
          // Draw each turtle in the group
          const turtleCount = Math.floor(obj.len / CELL);
          for (let t = 0; t < turtleCount; t++) {
            drawTurtle(ctx, obj.x + t * CELL, ly, obj.diving);
          }
        }
      }
    }

    // Row 8: safe median
    drawGrassRow(ctx, 8 * CELL);

    // Rows 9-13: road
    for (let r = 9; r <= 13; r++) {
      ctx.fillStyle = C.road;
      ctx.fillRect(0, r * CELL, W, CELL);
      // Lane lines
      ctx.fillStyle = C.roadLine;
      if (r > 9) {
        for (let lx = 0; lx < W; lx += 16) {
          ctx.fillRect(lx + 2, r * CELL, 8, 1);
        }
      }
    }
    // Road edges
    ctx.fillStyle = C.roadEdge;
    ctx.fillRect(0, 9 * CELL, W, 1);
    ctx.fillRect(0, 14 * CELL - 1, W, 1);

    // Draw road vehicles
    for (const lane of lanesRef.current) {
      if (lane.def.type !== "road") continue;
      const ly = lane.def.row * CELL;
      for (const obj of lane.objects) {
        if (obj.x + obj.len < -CELL || obj.x > W + CELL) continue;
        if (lane.def.objType === "truck") {
          drawTruck(ctx, obj.x, ly, obj.len, lane.def.dir);
        } else {
          drawCar(ctx, obj.x, ly, lane.def.objType, lane.def.dir);
        }
      }
    }

    // Rows 14-15: safe start zones
    drawGrassRow(ctx, 14 * CELL);
    drawGrassRow(ctx, 15 * CELL);

    // Draw frog
    const isDying = phaseRef.current === "dying";
    if (isDying && deathTypeRef.current === "water") {
      drawWaterDeathRipple(ctx, frogPxX.current, frogPxY.current, deathFrameRef.current);
    } else {
      drawPixelFrog(ctx, frogPxX.current, frogPxY.current,
        isDying ? "idle" : (frogHopping.current ? frogDir.current : "idle"),
        isDying && deathTypeRef.current === "road");
    }

    // Score display (top area)
    ctx.font = "bold 10px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = C.textSh;
    ctx.fillText(`SCORE`, 3, 3);
    ctx.fillStyle = C.text;
    ctx.fillText(`SCORE`, 2, 2);
    ctx.fillStyle = C.textSh;
    ctx.fillText(String(scoreRef.current), 3, 13);
    ctx.fillStyle = "#5eead4";
    ctx.fillText(String(scoreRef.current), 2, 12);

    // Level
    ctx.textAlign = "center";
    ctx.fillStyle = C.textSh;
    ctx.fillText(`LVL ${levelRef.current}`, W / 2 + 1, 3);
    ctx.fillStyle = C.text;
    ctx.fillText(`LVL ${levelRef.current}`, W / 2, 2);

    // High score
    if (bestRef.current > 0) {
      ctx.textAlign = "right";
      ctx.fillStyle = C.textSh;
      ctx.fillText(`HI ${bestRef.current}`, W - 1, 3);
      ctx.fillStyle = C.text;
      ctx.fillText(`HI ${bestRef.current}`, W - 2, 2);
    }

    // Timer bar (bottom of play area, row 15 bottom)
    if (phaseRef.current === "playing" || phaseRef.current === "dying") {
      const timerPct = Math.max(0, timerRef.current / TIMER_FRAMES);
      const barW = Math.floor((W - 40) * timerPct);
      const barY = H - 6;
      ctx.fillStyle = "#222222";
      ctx.fillRect(20, barY, W - 40, 4);
      ctx.fillStyle = timerPct > 0.5 ? C.timerFull : timerPct > 0.2 ? C.timerMid : C.timerLow;
      ctx.fillRect(20, barY, barW, 4);
    }

    // Lives display (bottom left)
    if (phaseRef.current !== "idle") {
      for (let i = 0; i < livesRef.current - 1; i++) {
        const lx = 4 + i * 12;
        const ly = H - 14;
        ctx.fillStyle = C.lifeFrog;
        ctx.fillRect(lx + 1, ly + 1, 8, 6);
        ctx.fillRect(lx + 2, ly, 6, 8);
        ctx.fillStyle = C.frogDk;
        ctx.fillRect(lx + 3, ly + 2, 4, 4);
      }
    }

    // Death flash overlay
    if (flashFramesRef.current > 0) {
      ctx.fillStyle = C.text;
      ctx.globalAlpha = (flashFramesRef.current / 6) * 0.7;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  };

  /* ---- Game loop ---- */
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
        idleTickRef.current++;

        // Process input
        if (!frogHopping.current && frogCooldown.current <= 0 && inputQueueRef.current.length > 0) {
          const dir = inputQueueRef.current.shift()!;
          let newCol = frogCol.current;
          let newRow = frogRow.current;
          if (dir === "up") newRow--;
          else if (dir === "down") newRow++;
          else if (dir === "left") newCol--;
          else if (dir === "right") newCol++;

          // Bounds check
          if (newCol >= 0 && newCol < COLS && newRow >= 2 && newRow <= FROG_START_ROW) {
            frogCol.current = newCol;
            frogRow.current = newRow;
            frogTargetX.current = newCol * CELL;
            frogTargetY.current = newRow * CELL;
            frogHopping.current = true;
            frogHopFrame.current = 0;
            frogDir.current = dir;

            // Score for forward hop
            if (newRow < highestRow.current) {
              scoreRef.current += PTS_HOP;
              setScore(scoreRef.current);
              highestRow.current = newRow;
            }
          }
        }

        // Hop animation
        if (frogHopping.current) {
          frogHopFrame.current++;
          const t = frogHopFrame.current / HOP_FRAMES;
          const startX = frogTargetX.current - (frogDir.current === "left" ? -CELL : frogDir.current === "right" ? CELL : 0);
          const startY = frogTargetY.current - (frogDir.current === "up" ? -CELL : frogDir.current === "down" ? CELL : 0);
          frogPxX.current = startX + (frogTargetX.current - startX) * t;
          frogPxY.current = startY + (frogTargetY.current - startY) * t;

          if (frogHopFrame.current >= HOP_FRAMES) {
            frogPxX.current = frogTargetX.current;
            frogPxY.current = frogTargetY.current;
            frogHopping.current = false;
            frogCooldown.current = HOP_COOLDOWN;
          }
        }

        // Cooldown
        if (frogCooldown.current > 0) frogCooldown.current--;

        // Move lane objects
        for (const lane of lanesRef.current) {
          for (const obj of lane.objects) {
            obj.x += lane.speed;

            // Wrap around — ensure objects always re-enter from off-screen edge
            const totalSpan = Math.max((lane.def.objLen + lane.def.gap) * CELL * lane.def.count, W + obj.len + CELL);
            if (lane.speed > 0 && obj.x > W + CELL) {
              obj.x -= totalSpan;
            } else if (lane.speed < 0 && obj.x + obj.len < -CELL) {
              obj.x += totalSpan;
            }

            // Turtle dive timer
            if (lane.def.objType === "turtle") {
              obj.diveTimer--;
              if (obj.diveTimer <= 0) {
                obj.diving = !obj.diving;
                obj.diveTimer = obj.diving ? 60 + Math.floor(Math.random() * 40) : 120 + Math.floor(Math.random() * 180);
              }
            }
          }
        }

        // Frog on river — check platform
        if (!frogHopping.current && frogRow.current >= 3 && frogRow.current <= 7) {
          let onPlatform = false;
          let platformSpeed = 0;
          const frogCX = frogPxX.current + CELL / 2;
          const frogCY = frogPxY.current + CELL / 2;

          for (const lane of lanesRef.current) {
            if (lane.def.row !== frogRow.current) continue;
            if (lane.def.type !== "river") continue;
            for (const obj of lane.objects) {
              if (lane.def.objType === "turtle" && obj.diving) continue;
              if (frogCX >= obj.x && frogCX < obj.x + obj.len &&
                  frogCY >= lane.def.row * CELL && frogCY < (lane.def.row + 1) * CELL) {
                onPlatform = true;
                platformSpeed = lane.speed;
                break;
              }
            }
            if (onPlatform) break;
          }

          if (onPlatform) {
            // Ride the platform
            frogPxX.current += platformSpeed;
            frogCol.current = Math.round(frogPxX.current / CELL);
            frogTargetX.current = frogPxX.current;

            // Carried off edge
            if (frogPxX.current < -CELL || frogPxX.current > W) {
              startDying("edge");
              drawRef.current();
              return;
            }
          } else {
            // In water without platform
            startDying("water");
            drawRef.current();
            return;
          }
        }

        // Check home pads (row 2)
        if (!frogHopping.current && frogRow.current === 2) {
          let landedOnPad = false;
          for (let i = 0; i < HOME_SLOTS; i++) {
            const padX = getHomePadX(i);
            const frogCX = frogPxX.current + CELL / 2;
            if (Math.abs(frogCX - (padX + CELL / 2)) < CELL * 0.7) {
              if (!filledPadsRef.current[i]) {
                filledPadsRef.current[i] = true;
                frogsHomeRef.current++;
                setDisplayFrogs(frogsHomeRef.current);
                // Score for pad + time bonus
                const timeBonus = Math.floor((timerRef.current / 30) * 10);
                scoreRef.current += PTS_PAD + timeBonus;
                setScore(scoreRef.current);
                landedOnPad = true;

                // Check if all pads filled
                if (frogsHomeRef.current >= HOME_SLOTS) {
                  advanceLevel();
                  drawRef.current();
                  rafRef.current = requestAnimationFrame(loop);
                  return;
                }

                // Reset frog to start
                resetFrog();
                break;
              } else {
                // Pad already filled — death
                startDying("road");
                drawRef.current();
                return;
              }
            }
          }

          if (!landedOnPad) {
            // Jumped into hedge (not on a pad)
            startDying("road");
            drawRef.current();
            return;
          }
        }

        // Road collision check
        if (!frogHopping.current && frogRow.current >= 9 && frogRow.current <= 13) {
          const frogL = frogPxX.current + 2;
          const frogR = frogPxX.current + CELL - 2;
          const frogT = frogPxY.current + 2;
          const frogB = frogPxY.current + CELL - 2;

          for (const lane of lanesRef.current) {
            if (lane.def.row !== frogRow.current) continue;
            if (lane.def.type !== "road") continue;
            for (const obj of lane.objects) {
              const objL = obj.x;
              const objR = obj.x + obj.len;
              const objT = lane.def.row * CELL + 2;
              const objB = (lane.def.row + 1) * CELL - 2;
              if (frogL < objR && frogR > objL && frogT < objB && frogB > objT) {
                startDying("road");
                drawRef.current();
                return;
              }
            }
          }
        }

        // Timer
        timerRef.current--;
        if (timerRef.current <= 0) {
          startDying("time");
          drawRef.current();
          return;
        }
      }

      drawRef.current();
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, startDying, advanceLevel, resetFrog]);

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

        if (flashFramesRef.current > 0) flashFramesRef.current--;
        deathFrameRef.current++;

        if (deathFrameRef.current >= deathDuration) {
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
    lanesRef.current = createLanes(1);
    filledPadsRef.current = [false, false, false, false, false];
    frogCol.current = FROG_START_COL;
    frogRow.current = FROG_START_ROW;

    const idleLoop = (time: number) => {
      if (phaseRef.current !== "idle") return;
      idleTickRef.current++;

      // Animate lanes in idle
      for (const lane of lanesRef.current) {
        for (const obj of lane.objects) {
          obj.x += lane.speed * 0.5;
          const totalSpan = Math.max((lane.def.objLen + lane.def.gap) * CELL * lane.def.count, W + obj.len + CELL);
          if (lane.speed > 0 && obj.x > W + CELL) obj.x -= totalSpan;
          else if (lane.speed < 0 && obj.x + obj.len < -CELL) obj.x += totalSpan;
        }
      }

      // Frog idle bob
      frogPxX.current = FROG_START_COL * CELL;
      frogPxY.current = FROG_START_ROW * CELL + Math.sin(time / 400) * 2;
      frogDir.current = "idle";

      drawRef.current();
      rafRef.current = requestAnimationFrame(idleLoop);
    };

    rafRef.current = requestAnimationFrame(idleLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase]);

  // Slide in results panel
  useEffect(() => {
    if (phase === "over") {
      const timer = setTimeout(() => setShowResults(true), 50);
      return () => clearTimeout(timer);
    }
    setShowResults(false);
  }, [phase]);

  // Redraw on phase change (for static states)
  useEffect(() => {
    if (phaseRef.current === "over" || phaseRef.current === "dying") drawRef.current();
  }, [phase]);

  /* ---- Input handling ---- */
  const handleInput = useCallback((dir: string) => {
    if (phaseRef.current === "idle") { initGame(); return; }
    if (phaseRef.current === "dying") return;
    if (phaseRef.current === "over") { initGame(); return; }
    if (phaseRef.current === "playing" && !pausedRef.current) {
      // Only queue if not already full
      if (inputQueueRef.current.length < 2) {
        inputQueueRef.current.push(dir);
      }
    }
  }, [initGame]);

  // Keyboard listener — scoped to container ref
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const h = (e: KeyboardEvent) => {
      if (e.code === "ArrowUp" || e.key === "w" || e.key === "W") {
        e.preventDefault(); e.stopPropagation();
        handleInput("up");
      } else if (e.code === "ArrowDown" || e.key === "s" || e.key === "S") {
        e.preventDefault(); e.stopPropagation();
        handleInput("down");
      } else if (e.code === "ArrowLeft" || e.key === "a" || e.key === "A") {
        e.preventDefault(); e.stopPropagation();
        handleInput("left");
      } else if (e.code === "ArrowRight" || e.key === "d" || e.key === "D") {
        e.preventDefault(); e.stopPropagation();
        handleInput("right");
      } else if (e.code === "Space") {
        e.preventDefault(); e.stopPropagation();
        if (phaseRef.current === "idle" || phaseRef.current === "over") {
          handleInput("up");
        }
      }
    };
    el.addEventListener("keydown", h);
    return () => el.removeEventListener("keydown", h);
  }, [handleInput]);

  // Auto-focus
  useEffect(() => { containerRef.current?.focus(); }, [phase]);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      style={{
        width: "100%", height: "100%", position: "relative", outline: "none",
        display: "flex", flexDirection: "column", backgroundColor: "#0a0a0a",
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
          {phase === "idle" ? "Arrow keys to hop" : `Lvl ${displayLevel} | Frogs: ${displayFrogs}/${HOME_SLOTS}`}
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
          backgroundColor: "#0a0a0a",
        }}
      >
        <canvas
          ref={canvasRef}
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
              Frogger
            </div>
            <div onClick={() => handleInput("up")} style={{
              padding: "8px 24px", fontSize: 14, fontWeight: 700,
              color: "#0a0a18", backgroundColor: "#5eead4",
              borderRadius: 2, cursor: "pointer", userSelect: "none",
              fontFamily: "monospace", textTransform: "uppercase",
              border: "2px solid #3ac0a8",
            }}>
              Start Game
            </div>
            <div style={{ fontSize: 11, color: "#888", fontFamily: "monospace", textTransform: "uppercase" }}>
              Arrow Keys / WASD to Move
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

                {/* Stats row */}
                <div style={{
                  display: "flex", gap: 16, marginTop: 4,
                  fontSize: 11, fontFamily: "monospace", color: "#999",
                }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ color: "#666", fontSize: 9, textTransform: "uppercase", letterSpacing: 1 }}>Frogs</div>
                    <div style={{ color: "#5eead4", fontSize: 16, fontWeight: 700 }}>{displayFrogs}</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ color: "#666", fontSize: 9, textTransform: "uppercase", letterSpacing: 1 }}>Level</div>
                    <div style={{ color: "#5eead4", fontSize: 16, fontWeight: 700 }}>{displayLevel}</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ color: "#666", fontSize: 9, textTransform: "uppercase", letterSpacing: 1 }}>Lives</div>
                    <div style={{ color: "#5eead4", fontSize: 16, fontWeight: 700 }}>{displayLives}</div>
                  </div>
                </div>
              </div>

              <div onClick={() => handleInput("up")} style={{
                padding: "8px 24px", fontSize: 14, fontWeight: 700,
                color: "#0a0a18", backgroundColor: "#5eead4",
                borderRadius: 2, cursor: "pointer", userSelect: "none",
                fontFamily: "monospace", textTransform: "uppercase",
                border: "2px solid #3ac0a8", marginTop: 4,
              }}>
                Play Again
              </div>
              <div style={{ fontSize: 11, color: "#888", fontFamily: "monospace", textTransform: "uppercase" }}>
                Space to Retry
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

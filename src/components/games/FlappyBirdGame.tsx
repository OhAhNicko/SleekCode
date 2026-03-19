import { useRef, useEffect, useState, useCallback } from "react";

interface FlappyBirdGameProps {
  onAddHighscore: (score: number) => void;
  paused?: boolean;
}

type GamePhase = "idle" | "playing" | "dying" | "over";

interface Pipe { x: number; gapY: number; scored: boolean }

/* ---- Original Flappy Bird constants (288×512 @ 30 fps) ---- */
const W = 288;
const H = 512;
const GROUND_Y = 400;
const GROUND_H = H - GROUND_Y;

const BIRD_W = 17;
const BIRD_H = 12;
const BIRD_X = 57;
const BIRD_START_Y = 200;

const GRAVITY = 1;
const FLAP_VEL = -9;
const MAX_FALL = 10;
const MAX_RISE = -8;
const FRAME_MS = 1000 / 30;

const PIPE_W = 52;
const PIPE_GAP = 100;
const PIPE_CAP_H = 13;
const PIPE_CAP_OVER = 3;
const PIPE_SPEED = 4;
const PIPE_SPACING = 200;
const MIN_GAP_Y = 60;
const MAX_GAP_Y = GROUND_Y - PIPE_GAP - 40;
const HIT_SHRINK = 2;
const TW = W * 3; // terrain generation width

/* ---- Static colors (bird, pipe, text — constant across themes) ---- */
const C = {
  star: "#ffffff",
  pipeBody: "#2a7a3a", pipeHi: "#3a9a4a", pipeSh: "#1a5a2a",
  pipeCap: "#3aaa4a", pipeCapEdge: "#2a8a3a",
  birdBody: "#e8c835", birdBelly: "#f0d850", birdDk: "#c8a825",
  wingUp: "#d8b830", wingMid: "#c8a825", wingDn: "#b89820",
  eyeW: "#ffffff", eyeB: "#1a1a1a",
  beak: "#e85535", beakDk: "#c84525",
  text: "#ffffff", textSh: "#000000",
};

/* ---- Scenery themes (change palette every 10, terrain every 20) ---- */
type SceneryType = "city" | "beach" | "mountains" | "desert" | "cyber";

interface Theme {
  sky1: string; sky2: string; starAlpha: number;
  ground: string; groundDk: string; groundLn: string;
  far: string; farEdge: string; near: string; nearEdge: string;
  detail1: string; detail2: string;
  scenery: SceneryType;
  label: string;
}

const THEMES: Theme[] = [
  // 0-9: City — Night
  { sky1: "#0f1021", sky2: "#181838", starAlpha: 1, ground: "#5a4a3a", groundDk: "#4a3a2a", groundLn: "#6a5a4a", far: "#18183a", farEdge: "#222250", near: "#242450", nearEdge: "#2e2e68", detail1: "#e8d44d", detail2: "#6a6030", scenery: "city", label: "Night City" },
  // 10-19: City — Sunset
  { sky1: "#1a0a28", sky2: "#5a2838", starAlpha: 0.3, ground: "#5a4535", groundDk: "#4a3525", groundLn: "#6a5545", far: "#2a1530", farEdge: "#3a2542", near: "#351838", nearEdge: "#452a50", detail1: "#ff8844", detail2: "#8a4422", scenery: "city", label: "Sunset City" },
  // 20-29: Beach — Day
  { sky1: "#204868", sky2: "#508898", starAlpha: 0, ground: "#c8b070", groundDk: "#b8a060", groundLn: "#d8c080", far: "#306878", farEdge: "#408888", near: "#c0a858", nearEdge: "#b09848", detail1: "#40a848", detail2: "#308838", scenery: "beach", label: "Sunny Beach" },
  // 30-39: Beach — Dusk
  { sky1: "#1a1030", sky2: "#603050", starAlpha: 0.4, ground: "#8a7050", groundDk: "#7a6040", groundLn: "#9a8060", far: "#402838", farEdge: "#503848", near: "#8a6840", nearEdge: "#7a5830", detail1: "#305828", detail2: "#204818", scenery: "beach", label: "Dusk Beach" },
  // 40-49: Mountains — Day
  { sky1: "#304858", sky2: "#607888", starAlpha: 0, ground: "#586848", groundDk: "#485838", groundLn: "#687858", far: "#556068", farEdge: "#687880", near: "#485838", nearEdge: "#586848", detail1: "#f0f0f8", detail2: "#384830", scenery: "mountains", label: "Alpine Day" },
  // 50-59: Mountains — Aurora Night
  { sky1: "#080818", sky2: "#101828", starAlpha: 0.9, ground: "#384038", groundDk: "#283028", groundLn: "#485048", far: "#283038", farEdge: "#384048", near: "#203028", nearEdge: "#304038", detail1: "#d0e0e8", detail2: "#203020", scenery: "mountains", label: "Aurora Peaks" },
  // 60-69: Desert — Scorching
  { sky1: "#584020", sky2: "#886838", starAlpha: 0, ground: "#c8a050", groundDk: "#b89040", groundLn: "#d8b060", far: "#a88838", farEdge: "#b89848", near: "#c89840", nearEdge: "#b88830", detail1: "#408830", detail2: "#306820", scenery: "desert", label: "Scorching Desert" },
  // 70-79: Desert — Twilight
  { sky1: "#180a20", sky2: "#402030", starAlpha: 0.6, ground: "#685030", groundDk: "#584020", groundLn: "#786040", far: "#483020", farEdge: "#584030", near: "#583828", nearEdge: "#482818", detail1: "#306020", detail2: "#205010", scenery: "desert", label: "Twilight Sands" },
  // 80+: Cyber City — Neon
  { sky1: "#060018", sky2: "#100030", starAlpha: 0.8, ground: "#201828", groundDk: "#181020", groundLn: "#302838", far: "#0a0828", farEdge: "#141040", near: "#100a30", nearEdge: "#1a1248", detail1: "#00ffaa", detail2: "#005533", scenery: "cyber", label: "Cyber Night" },
];

function getTheme(score: number): Theme {
  return THEMES[Math.min(Math.floor(score / 10), THEMES.length - 1)];
}

/* ---- Medals ---- */
interface Medal { name: string; color: string; border: string }
function getMedal(score: number): Medal | null {
  if (score >= 40) return { name: "PLATINUM", color: "#e0e0e8", border: "#a0a0b0" };
  if (score >= 30) return { name: "GOLD", color: "#ffd700", border: "#cc9900" };
  if (score >= 20) return { name: "SILVER", color: "#c0c0c0", border: "#909090" };
  if (score >= 10) return { name: "BRONZE", color: "#cd7f32", border: "#9a5a1a" };
  return null;
}

/* ---- Terrain data types ---- */
interface Bld { x: number; w: number; h: number; lit: boolean[]; wCols: number; wRows: number }
interface Palm { x: number; h: number; lean: number }
interface Dune { x: number; w: number; h: number }
interface Peak { x: number; w: number; h: number; snow: boolean }
interface Pine { x: number; h: number }
interface Mesa { x: number; w: number; h: number }
interface Cactus { x: number; h: number; arms: number }

interface Terrain {
  cityFar: Bld[]; cityNear: Bld[];
  palms: Palm[]; dunes: Dune[];
  peaks: Peak[]; pines: Pine[];
  mesas: Mesa[]; cacti: Cactus[];
  cyberFar: Bld[]; cyberNear: Bld[];
  stars: [number, number, number][];
}

/* ---- Terrain generation ---- */
function genBlds(tw: number, minH: number, maxH: number, litPct: number): Bld[] {
  const out: Bld[] = [];
  let x = 0;
  while (x < tw) {
    const w = 12 + Math.floor(Math.random() * 24);
    const h = minH + Math.floor(Math.random() * (maxH - minH));
    const wCols = Math.floor((w - 4) / 5);
    const wRows = Math.floor((h - 6) / 7);
    const lit: boolean[] = [];
    for (let i = 0; i < wCols * wRows; i++) lit.push(Math.random() < litPct);
    out.push({ x, w, h, lit, wCols, wRows });
    x += w + 2 + Math.floor(Math.random() * 4);
  }
  return out;
}

function genPalms(tw: number, count: number): Palm[] {
  const out: Palm[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: Math.floor(Math.random() * tw), h: 30 + Math.floor(Math.random() * 50), lean: (Math.random() - 0.5) * 12 });
  }
  return out.sort((a, b) => a.x - b.x);
}

function genDunes(tw: number): Dune[] {
  const out: Dune[] = [];
  let x = 0;
  while (x < tw) {
    const w = 40 + Math.floor(Math.random() * 80);
    const h = 10 + Math.floor(Math.random() * 30);
    out.push({ x, w, h });
    x += w - 10 + Math.floor(Math.random() * 20);
  }
  return out;
}

function genPeaks(tw: number): Peak[] {
  const out: Peak[] = [];
  let x = 0;
  while (x < tw) {
    const w = 50 + Math.floor(Math.random() * 80);
    const h = 60 + Math.floor(Math.random() * 120);
    out.push({ x, w, h, snow: h > 100 });
    x += w * 0.6 + Math.floor(Math.random() * 30);
  }
  return out;
}

function genPines(tw: number): Pine[] {
  const out: Pine[] = [];
  for (let i = 0; i < Math.floor(tw / 12); i++) {
    out.push({ x: Math.floor(Math.random() * tw), h: 12 + Math.floor(Math.random() * 20) });
  }
  return out.sort((a, b) => a.x - b.x);
}

function genMesas(tw: number): Mesa[] {
  const out: Mesa[] = [];
  let x = 0;
  while (x < tw) {
    const w = 40 + Math.floor(Math.random() * 60);
    const h = 30 + Math.floor(Math.random() * 80);
    out.push({ x, w, h });
    x += w + 20 + Math.floor(Math.random() * 40);
  }
  return out;
}

function genCacti(tw: number): Cactus[] {
  const out: Cactus[] = [];
  for (let i = 0; i < Math.floor(tw / 20); i++) {
    out.push({ x: Math.floor(Math.random() * tw), h: 15 + Math.floor(Math.random() * 25), arms: Math.floor(Math.random() * 3) });
  }
  return out.sort((a, b) => a.x - b.x);
}

function genStars(n: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < n; i++) out.push([Math.floor(Math.random() * W), Math.floor(Math.random() * (GROUND_Y - 100)), 0.25 + Math.random() * 0.55]);
  return out;
}

function genTerrain(): Terrain {
  return {
    cityFar: genBlds(TW, 50, 160, 0.3), cityNear: genBlds(TW, 30, 100, 0.45),
    palms: genPalms(TW, 60), dunes: genDunes(TW),
    peaks: genPeaks(TW), pines: genPines(TW),
    mesas: genMesas(TW), cacti: genCacti(TW),
    cyberFar: genBlds(TW, 80, 200, 0.15), cyberNear: genBlds(TW, 40, 130, 0.2),
    stars: genStars(50),
  };
}

/* ---- Scenery draw helpers ---- */

function getTotal<T extends { x: number; w?: number }>(items: T[]): number {
  if (items.length === 0) return W;
  const last = items[items.length - 1];
  return Math.max((last.x + (last.w ?? 20)) + 4, W);
}

function drawBldLayer(ctx: CanvasRenderingContext2D, blds: Bld[], scroll: number, body: string, edge: string, wb: string, wd: string) {
  const total = getTotal(blds);
  const off = scroll % total;
  for (let cp = 0; cp < 2; cp++) {
    const sh = cp * total;
    for (const b of blds) {
      const bx = Math.floor(b.x - off + sh);
      if (bx > W + 10 || bx + b.w < -10) continue;
      const by = GROUND_Y - b.h;
      ctx.fillStyle = body;
      ctx.fillRect(bx, by, b.w, b.h);
      ctx.fillStyle = edge;
      ctx.fillRect(bx, by, b.w, 1);
      ctx.fillRect(bx, by, 1, b.h);
      for (let r = 0; r < b.wRows; r++) {
        for (let c = 0; c < b.wCols; c++) {
          if (!b.lit[r * b.wCols + c]) continue;
          const wx = bx + 3 + c * 5, wy = by + 4 + r * 7;
          if (wx + 3 > bx + b.w || wy + 3 > by + b.h) continue;
          ctx.fillStyle = (c + r) % 3 === 0 ? wb : wd;
          ctx.fillRect(wx, wy, 2, 3);
        }
      }
    }
  }
}

function drawCyberLayer(ctx: CanvasRenderingContext2D, blds: Bld[], scroll: number, body: string, edge: string, neon: string) {
  const total = getTotal(blds);
  const off = scroll % total;
  for (let cp = 0; cp < 2; cp++) {
    const sh = cp * total;
    for (const b of blds) {
      const bx = Math.floor(b.x - off + sh);
      if (bx > W + 10 || bx + b.w < -10) continue;
      const by = GROUND_Y - b.h;
      ctx.fillStyle = body;
      ctx.fillRect(bx, by, b.w, b.h);
      ctx.fillStyle = edge;
      ctx.fillRect(bx, by, b.w, 1);
      ctx.fillRect(bx, by, 1, b.h);
      ctx.fillRect(bx + b.w - 1, by, 1, b.h);
      // Neon vertical strip
      ctx.fillStyle = neon;
      ctx.globalAlpha = 0.6;
      const stripX = bx + Math.floor(b.w / 2) - 1;
      ctx.fillRect(stripX, by + 2, 2, b.h - 4);
      ctx.globalAlpha = 1;
      // Neon horizontal bands
      for (let r = 0; r < b.wRows; r++) {
        if (!b.lit[r * b.wCols]) continue;
        const ny = by + 4 + r * 7;
        ctx.fillStyle = neon;
        ctx.globalAlpha = 0.35;
        ctx.fillRect(bx + 1, ny, b.w - 2, 1);
        ctx.globalAlpha = 1;
      }
    }
  }
}

function drawBeachLayer(ctx: CanvasRenderingContext2D, dunes: Dune[], palms: Palm[], scroll: number, farLayer: boolean, t: Theme) {
  // Dunes
  const dtotal = getTotal(dunes);
  const doff = scroll % dtotal;
  for (let cp = 0; cp < 2; cp++) {
    const sh = cp * dtotal;
    for (const d of dunes) {
      const dx = Math.floor(d.x - doff + sh);
      if (dx > W + 10 || dx + d.w < -10) continue;
      const dy = GROUND_Y - d.h;
      // Simple hill shape (pixelated curve via stacked rects)
      ctx.fillStyle = farLayer ? t.far : t.near;
      for (let row = 0; row < d.h; row++) {
        const frac = row / d.h;
        const hw = Math.floor(d.w * 0.5 * Math.sqrt(1 - frac * frac));
        ctx.fillRect(dx + Math.floor(d.w / 2) - hw, dy + d.h - row, hw * 2, 1);
      }
    }
  }
  if (farLayer) return;
  // Palm trees (near layer only)
  const ptotal = palms.length > 0 ? palms[palms.length - 1].x + 20 : W;
  const poff = scroll % Math.max(ptotal, W);
  for (let cp = 0; cp < 2; cp++) {
    const sh = cp * Math.max(ptotal, W);
    for (const p of palms) {
      const px = Math.floor(p.x - poff + sh);
      if (px > W + 20 || px < -20) continue;
      const by = GROUND_Y;
      // Trunk
      ctx.fillStyle = t.nearEdge;
      for (let i = 0; i < p.h; i++) {
        const lean = Math.floor(p.lean * (i / p.h));
        ctx.fillRect(px + lean, by - i, 3, 1);
      }
      // Fronds (leaf clusters)
      const topX = px + Math.floor(p.lean);
      const topY = by - p.h;
      ctx.fillStyle = t.detail1;
      ctx.fillRect(topX - 8, topY - 2, 18, 3);
      ctx.fillRect(topX - 6, topY - 4, 14, 2);
      ctx.fillRect(topX - 10, topY + 1, 8, 2);
      ctx.fillRect(topX + 4, topY + 1, 8, 2);
      ctx.fillStyle = t.detail2;
      ctx.fillRect(topX - 5, topY - 1, 12, 1);
    }
  }
}

function drawMountainLayer(ctx: CanvasRenderingContext2D, peaks: Peak[], pines: Pine[], scroll: number, farLayer: boolean, t: Theme) {
  // Peaks
  const ptotal = getTotal(peaks);
  const poff = scroll % ptotal;
  for (let cp = 0; cp < 2; cp++) {
    const sh = cp * ptotal;
    for (const pk of peaks) {
      const px = Math.floor(pk.x - poff + sh);
      if (px > W + 10 || px + pk.w < -10) continue;
      const by = GROUND_Y;
      // Triangle mountain (pixel art)
      ctx.fillStyle = farLayer ? t.far : t.near;
      for (let row = 0; row < pk.h; row++) {
        const frac = row / pk.h;
        const hw = Math.floor((pk.w / 2) * (1 - frac));
        ctx.fillRect(px + Math.floor(pk.w / 2) - hw, by - row, hw * 2, 1);
      }
      // Snow cap
      if (pk.snow) {
        ctx.fillStyle = t.detail1;
        const snowH = Math.floor(pk.h * 0.25);
        for (let row = pk.h - snowH; row < pk.h; row++) {
          const frac = row / pk.h;
          const hw = Math.floor((pk.w / 2) * (1 - frac));
          ctx.fillRect(px + Math.floor(pk.w / 2) - hw, by - row, hw * 2, 1);
        }
      }
      // Edge highlight
      ctx.fillStyle = farLayer ? t.farEdge : t.nearEdge;
      for (let row = 0; row < pk.h; row++) {
        const frac = row / pk.h;
        const hw = Math.floor((pk.w / 2) * (1 - frac));
        ctx.fillRect(px + Math.floor(pk.w / 2) - hw, by - row, 1, 1);
      }
    }
  }
  if (farLayer) return;
  // Pine trees (near layer only)
  const ttotal = pines.length > 0 ? pines[pines.length - 1].x + 10 : W;
  const toff = scroll % Math.max(ttotal, W);
  for (let cp = 0; cp < 2; cp++) {
    const sh = cp * Math.max(ttotal, W);
    for (const tr of pines) {
      const tx = Math.floor(tr.x - toff + sh);
      if (tx > W + 10 || tx < -10) continue;
      // Trunk
      ctx.fillStyle = t.nearEdge;
      ctx.fillRect(tx, GROUND_Y - 4, 2, 4);
      // Foliage (triangle layers)
      ctx.fillStyle = t.detail2;
      for (let layer = 0; layer < 3; layer++) {
        const ly = GROUND_Y - 4 - layer * Math.floor(tr.h / 3);
        const lw = Math.floor(tr.h * 0.5) - layer * 2;
        for (let row = 0; row < Math.floor(tr.h / 3); row++) {
          const frac = row / (tr.h / 3);
          const hw = Math.floor(lw * 0.5 * (1 - frac));
          ctx.fillRect(tx + 1 - hw, ly - row, hw * 2, 1);
        }
      }
    }
  }
}

function drawDesertLayer(ctx: CanvasRenderingContext2D, mesas: Mesa[], cacti: Cactus[], scroll: number, farLayer: boolean, t: Theme) {
  // Mesas (flat-topped mountains)
  const mtotal = getTotal(mesas);
  const moff = scroll % mtotal;
  for (let cp = 0; cp < 2; cp++) {
    const sh = cp * mtotal;
    for (const m of mesas) {
      const mx = Math.floor(m.x - moff + sh);
      if (mx > W + 10 || mx + m.w < -10) continue;
      const by = GROUND_Y;
      ctx.fillStyle = farLayer ? t.far : t.near;
      // Flat top
      const topW = Math.floor(m.w * 0.6);
      const topX = mx + Math.floor((m.w - topW) / 2);
      ctx.fillRect(topX, by - m.h, topW, m.h);
      // Sloped sides (stepped)
      for (let row = 0; row < m.h; row++) {
        const frac = row / m.h;
        const extraW = Math.floor((m.w - topW) * 0.5 * frac);
        ctx.fillRect(topX - extraW, by - row, topW + extraW * 2, 1);
      }
      // Edge
      ctx.fillStyle = farLayer ? t.farEdge : t.nearEdge;
      ctx.fillRect(topX, by - m.h, topW, 2);
    }
  }
  if (farLayer) return;
  // Cacti (near layer)
  const ctotal = cacti.length > 0 ? cacti[cacti.length - 1].x + 10 : W;
  const coff = scroll % Math.max(ctotal, W);
  for (let cp = 0; cp < 2; cp++) {
    const sh = cp * Math.max(ctotal, W);
    for (const c of cacti) {
      const cx = Math.floor(c.x - coff + sh);
      if (cx > W + 10 || cx < -10) continue;
      ctx.fillStyle = t.detail1;
      // Main stem
      ctx.fillRect(cx, GROUND_Y - c.h, 3, c.h);
      // Arms
      if (c.arms >= 1) {
        const ay = GROUND_Y - Math.floor(c.h * 0.6);
        ctx.fillRect(cx - 5, ay, 5, 2);
        ctx.fillRect(cx - 5, ay - 6, 2, 6);
      }
      if (c.arms >= 2) {
        const ay = GROUND_Y - Math.floor(c.h * 0.4);
        ctx.fillRect(cx + 3, ay, 5, 2);
        ctx.fillRect(cx + 6, ay - 5, 2, 5);
      }
    }
  }
}

function drawAuroraBands(ctx: CanvasRenderingContext2D, scroll: number) {
  const colors = ["#20aa60", "#40cc80", "#2080aa", "#6040aa"];
  ctx.globalAlpha = 0.12;
  for (let i = 0; i < colors.length; i++) {
    ctx.fillStyle = colors[i];
    const y = 30 + i * 28 + Math.floor(Math.sin((scroll * 0.01) + i) * 6);
    ctx.fillRect(0, y, W, 3);
    ctx.fillRect(20 + i * 30, y - 2, W - 40 - i * 30, 2);
  }
  ctx.globalAlpha = 1;
}

/* ---- Pipe, collision, spawn ---- */

function spawnPipe(): Pipe {
  return { x: W + 10, gapY: MIN_GAP_Y + Math.floor(Math.random() * (MAX_GAP_Y - MIN_GAP_Y)), scored: false };
}

function boxHit(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/* ---- Component ---- */

export default function FlappyBirdGame({ onAddHighscore, paused = false }: FlappyBirdGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);

  const [containerSize, setContainerSize] = useState({ w: 400, h: 600 });
  const [phase, setPhase] = useState<GamePhase>("idle");
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);

  const phaseRef = useRef<GamePhase>("idle");
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const birdY = useRef(BIRD_START_Y);
  const birdVY = useRef(0);
  const pipesRef = useRef<Pipe[]>([]);
  const scoreRef = useRef(0);
  const bestRef = useRef(0);
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const accumRef = useRef(0);
  const groundScroll = useRef(0);
  const wingFrame = useRef(0);
  const wingTimer = useRef(0);
  const birdRot = useRef(0);
  const farScroll = useRef(0);
  const nearScroll = useRef(0);

  // Death animation state
  const flashFrames = useRef(0);
  const deathGroundFrames = useRef(0);
  const [showResults, setShowResults] = useState(false);

  // All terrain data (generated once)
  const terrainRef = useRef<Terrain | null>(null);
  if (!terrainRef.current) terrainRef.current = genTerrain();
  const terrain = terrainRef.current;

  // CSS canvas sizing (9:16 aspect)
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

  const initGame = useCallback(() => {
    birdY.current = BIRD_START_Y;
    birdVY.current = 0;
    birdRot.current = 0;
    pipesRef.current = [];
    scoreRef.current = 0;
    accumRef.current = 0;
    lastTimeRef.current = 0;
    wingFrame.current = 0;
    wingTimer.current = 0;
    flashFrames.current = 0;
    deathGroundFrames.current = 0;
    setShowResults(false);
    setScore(0);
    setPhase("playing");
    phaseRef.current = "playing";
    birdVY.current = FLAP_VEL;
  }, []);

  // Start death sequence: bird gets small upward bump, then falls to ground
  const startDying = useCallback(() => {
    if (phaseRef.current === "dying") return;
    phaseRef.current = "dying";
    setPhase("dying");
    flashFrames.current = 6;
    deathGroundFrames.current = 0;
    birdVY.current = -5; // small upward bump like original
    lastTimeRef.current = 0;
    accumRef.current = 0;
  }, []);

  // Actually end the game (called after death animation)
  const finishDeath = useCallback(() => {
    phaseRef.current = "over";
    setPhase("over");
    const s = scoreRef.current;
    if (s > 0) onAddHighscore(s);
    if (s > bestRef.current) { bestRef.current = s; setBestScore(s); }
  }, [onAddHighscore]);

  const flap = useCallback(() => {
    if (phaseRef.current === "idle") { initGame(); return; }
    if (phaseRef.current === "playing" && !pausedRef.current) {
      birdVY.current = FLAP_VEL;
      birdRot.current = -25;
    }
    if (phaseRef.current === "dying") return; // ignore input during death
    if (phaseRef.current === "over") { initGame(); }
  }, [initGame]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const h = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === "ArrowUp" || e.key === "w" || e.key === "W") {
        e.preventDefault();
        e.stopPropagation();
        flap();
      }
    };
    el.addEventListener("keydown", h);
    return () => el.removeEventListener("keydown", h);
  }, [flap]);

  useEffect(() => { containerRef.current?.focus(); }, [phase]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = W;
    c.height = H;
  }, []);

  /* ---- Draw ---- */
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    const t = getTheme(scoreRef.current);

    // Sky
    const grad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    grad.addColorStop(0, t.sky1);
    grad.addColorStop(1, t.sky2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Stars
    if (t.starAlpha > 0) {
      ctx.fillStyle = C.star;
      for (const [sx, sy, sa] of terrain.stars) {
        ctx.globalAlpha = sa * t.starAlpha;
        ctx.fillRect(sx, sy, 1, 1);
      }
      ctx.globalAlpha = 1;
    }

    // Aurora bands for mountain night theme
    if (t.scenery === "mountains" && t.starAlpha > 0.5) {
      drawAuroraBands(ctx, farScroll.current);
    }

    // Scenery layers
    const fs = farScroll.current;
    const ns = nearScroll.current;
    switch (t.scenery) {
      case "city":
        drawBldLayer(ctx, terrain.cityFar, fs, t.far, t.farEdge, t.detail1, t.detail2);
        drawBldLayer(ctx, terrain.cityNear, ns, t.near, t.nearEdge, t.detail1, t.detail2);
        break;
      case "beach":
        drawBeachLayer(ctx, terrain.dunes, terrain.palms, fs, true, t);
        drawBeachLayer(ctx, terrain.dunes, terrain.palms, ns, false, t);
        break;
      case "mountains":
        drawMountainLayer(ctx, terrain.peaks, terrain.pines, fs, true, t);
        drawMountainLayer(ctx, terrain.peaks, terrain.pines, ns, false, t);
        break;
      case "desert":
        drawDesertLayer(ctx, terrain.mesas, terrain.cacti, fs, true, t);
        drawDesertLayer(ctx, terrain.mesas, terrain.cacti, ns, false, t);
        break;
      case "cyber":
        drawCyberLayer(ctx, terrain.cyberFar, fs, t.far, t.farEdge, t.detail1);
        drawCyberLayer(ctx, terrain.cyberNear, ns, t.near, t.nearEdge, t.detail1);
        break;
    }

    // Pipes
    for (const pipe of pipesRef.current) {
      const px = Math.floor(pipe.x);
      const gt = pipe.gapY;
      const gb = pipe.gapY + PIPE_GAP;

      if (gt - PIPE_CAP_H > 0) {
        ctx.fillStyle = C.pipeBody;
        ctx.fillRect(px, 0, PIPE_W, gt - PIPE_CAP_H);
        ctx.fillStyle = C.pipeHi;
        ctx.fillRect(px, 0, 3, gt - PIPE_CAP_H);
        ctx.fillStyle = C.pipeSh;
        ctx.fillRect(px + PIPE_W - 3, 0, 3, gt - PIPE_CAP_H);
      }
      ctx.fillStyle = C.pipeCap;
      ctx.fillRect(px - PIPE_CAP_OVER, gt - PIPE_CAP_H, PIPE_W + PIPE_CAP_OVER * 2, PIPE_CAP_H);
      ctx.fillStyle = C.pipeCapEdge;
      ctx.fillRect(px - PIPE_CAP_OVER, gt - PIPE_CAP_H, PIPE_W + PIPE_CAP_OVER * 2, 2);
      ctx.fillRect(px - PIPE_CAP_OVER, gt - 2, PIPE_W + PIPE_CAP_OVER * 2, 2);
      ctx.fillStyle = C.pipeHi;
      ctx.fillRect(px - PIPE_CAP_OVER, gt - PIPE_CAP_H + 2, 3, PIPE_CAP_H - 4);

      ctx.fillStyle = C.pipeCap;
      ctx.fillRect(px - PIPE_CAP_OVER, gb, PIPE_W + PIPE_CAP_OVER * 2, PIPE_CAP_H);
      ctx.fillStyle = C.pipeCapEdge;
      ctx.fillRect(px - PIPE_CAP_OVER, gb, PIPE_W + PIPE_CAP_OVER * 2, 2);
      ctx.fillRect(px - PIPE_CAP_OVER, gb + PIPE_CAP_H - 2, PIPE_W + PIPE_CAP_OVER * 2, 2);
      ctx.fillStyle = C.pipeHi;
      ctx.fillRect(px - PIPE_CAP_OVER, gb + 2, 3, PIPE_CAP_H - 4);
      const bbTop = gb + PIPE_CAP_H;
      if (GROUND_Y - bbTop > 0) {
        ctx.fillStyle = C.pipeBody;
        ctx.fillRect(px, bbTop, PIPE_W, GROUND_Y - bbTop);
        ctx.fillStyle = C.pipeHi;
        ctx.fillRect(px, bbTop, 3, GROUND_Y - bbTop);
        ctx.fillStyle = C.pipeSh;
        ctx.fillRect(px + PIPE_W - 3, bbTop, 3, GROUND_Y - bbTop);
      }
    }

    // Ground
    const gs = Math.floor(groundScroll.current) % 24;
    ctx.fillStyle = t.ground;
    ctx.fillRect(0, GROUND_Y, W, GROUND_H);
    ctx.fillStyle = t.groundLn;
    ctx.fillRect(0, GROUND_Y, W, 2);
    ctx.fillStyle = t.groundDk;
    for (let gx = -gs; gx < W; gx += 24) {
      ctx.fillRect(gx, GROUND_Y + 6, 12, 2);
      ctx.fillRect(gx + 12, GROUND_Y + 14, 12, 2);
    }
    ctx.fillStyle = t.groundLn;
    for (let gx = -gs + 6; gx < W; gx += 24) {
      ctx.fillRect(gx, GROUND_Y + 22, 8, 1);
    }

    // Bird
    const bx = Math.floor(BIRD_X - BIRD_W / 2);
    const byRaw = Math.floor(birdY.current - BIRD_H / 2);

    ctx.save();
    ctx.translate(BIRD_X, Math.floor(birdY.current));
    const rot = Math.min(Math.max(birdRot.current, -25), 70);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.translate(-BIRD_X, -Math.floor(birdY.current));

    ctx.fillStyle = C.birdBody;
    ctx.fillRect(bx + 2, byRaw, BIRD_W - 4, BIRD_H);
    ctx.fillRect(bx + 1, byRaw + 1, BIRD_W - 2, BIRD_H - 2);
    ctx.fillRect(bx, byRaw + 2, BIRD_W, BIRD_H - 4);
    ctx.fillStyle = C.birdBelly;
    ctx.fillRect(bx + 2, byRaw + 7, BIRD_W - 6, 3);
    ctx.fillStyle = C.birdDk;
    ctx.fillRect(bx + 2, byRaw, BIRD_W - 5, 2);

    const wf = wingFrame.current;
    ctx.fillStyle = wf === 0 ? C.wingUp : wf === 1 ? C.wingMid : C.wingDn;
    const wy = wf === 0 ? byRaw - 1 : wf === 1 ? byRaw + 4 : byRaw + 6;
    ctx.fillRect(bx + 1, wy, 8, 3);
    ctx.fillRect(bx, wy + 1, 9, 1);

    ctx.fillStyle = C.eyeW;
    ctx.fillRect(bx + BIRD_W - 7, byRaw + 2, 5, 5);
    ctx.fillStyle = C.eyeB;
    ctx.fillRect(bx + BIRD_W - 4, byRaw + 3, 2, 3);

    ctx.fillStyle = C.beak;
    ctx.fillRect(bx + BIRD_W - 1, byRaw + 5, 5, 3);
    ctx.fillRect(bx + BIRD_W + 1, byRaw + 4, 3, 5);
    ctx.fillStyle = C.beakDk;
    ctx.fillRect(bx + BIRD_W - 1, byRaw + 7, 5, 1);

    ctx.restore();

    // Score
    if (phaseRef.current !== "idle") {
      const s = String(scoreRef.current);
      ctx.font = "bold 28px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = C.textSh;
      ctx.fillText(s, W / 2 + 2, 22);
      ctx.fillStyle = C.text;
      ctx.fillText(s, W / 2, 20);
    }

    // Death flash overlay
    if (flashFrames.current > 0) {
      ctx.fillStyle = C.text;
      ctx.globalAlpha = flashFrames.current / 6 * 0.7;
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

        birdVY.current = Math.min(birdVY.current + GRAVITY, MAX_FALL);
        birdVY.current = Math.max(birdVY.current, MAX_RISE);
        birdY.current += birdVY.current;

        if (birdVY.current < 0) birdRot.current = -25;
        else birdRot.current = Math.min(birdRot.current + 3, 70);

        wingTimer.current++;
        if (wingTimer.current >= 4) {
          wingTimer.current = 0;
          wingFrame.current = (wingFrame.current + 1) % 3;
        }

        for (const p of pipesRef.current) p.x -= PIPE_SPEED;

        groundScroll.current += PIPE_SPEED;
        farScroll.current += PIPE_SPEED * 0.25;
        nearScroll.current += PIPE_SPEED * 0.5;

        pipesRef.current = pipesRef.current.filter((p) => p.x + PIPE_W > -10);

        const last = pipesRef.current[pipesRef.current.length - 1];
        if (!last || last.x <= W - PIPE_SPACING) pipesRef.current.push(spawnPipe());

        for (const p of pipesRef.current) {
          if (!p.scored && p.x + PIPE_W < BIRD_X - BIRD_W / 2) {
            p.scored = true;
            scoreRef.current++;
            setScore(scoreRef.current);
          }
        }

        const hx = BIRD_X - BIRD_W / 2 + HIT_SHRINK;
        const hy = birdY.current - BIRD_H / 2 + HIT_SHRINK;
        const hw = BIRD_W - HIT_SHRINK * 2;
        const hh = BIRD_H - HIT_SHRINK * 2;

        if (birdY.current + BIRD_H / 2 >= GROUND_Y || birdY.current - BIRD_H / 2 <= 0) {
          startDying(); drawRef.current(); return;
        }

        for (const p of pipesRef.current) {
          if (boxHit(hx, hy, hw, hh, p.x - PIPE_CAP_OVER, 0, PIPE_W + PIPE_CAP_OVER * 2, p.gapY)) {
            startDying(); drawRef.current(); return;
          }
          if (boxHit(hx, hy, hw, hh, p.x - PIPE_CAP_OVER, p.gapY + PIPE_GAP, PIPE_W + PIPE_CAP_OVER * 2, GROUND_Y - p.gapY - PIPE_GAP)) {
            startDying(); drawRef.current(); return;
          }
        }
      }

      drawRef.current();
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, startDying]);

  // Death animation: bird tumbles to ground, flash fades, then show results
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

        // Flash countdown
        if (flashFrames.current > 0) flashFrames.current--;

        // Bird physics (just gravity, no pipe movement)
        const onGround = birdY.current + BIRD_H / 2 >= GROUND_Y;

        if (!onGround) {
          birdVY.current = Math.min(birdVY.current + GRAVITY, MAX_FALL);
          birdY.current += birdVY.current;
          birdRot.current = Math.min(birdRot.current + 5, 90);

          // Clamp to ground
          if (birdY.current + BIRD_H / 2 >= GROUND_Y) {
            birdY.current = GROUND_Y - BIRD_H / 2;
            birdVY.current = 0;
          }
        } else {
          // On ground — count frames then show results
          deathGroundFrames.current++;
          if (deathGroundFrames.current >= 25) {
            finishDeath();
            drawRef.current();
            return;
          }
        }
      }

      drawRef.current();
      rafRef.current = requestAnimationFrame(deathLoop);
    };

    rafRef.current = requestAnimationFrame(deathLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, finishDeath]);

  // Slide in results panel after game over
  useEffect(() => {
    if (phase === "over") {
      const timer = setTimeout(() => setShowResults(true), 50);
      return () => clearTimeout(timer);
    }
    setShowResults(false);
  }, [phase]);

  // Idle animation
  useEffect(() => {
    if (phaseRef.current !== "idle") return;
    const idleLoop = (time: number) => {
      if (phaseRef.current !== "idle") return;
      birdY.current = BIRD_START_Y + Math.sin(time / 300) * 8;
      wingTimer.current++;
      if (wingTimer.current >= 8) {
        wingTimer.current = 0;
        wingFrame.current = (wingFrame.current + 1) % 3;
      }
      farScroll.current += 0.15;
      nearScroll.current += 0.3;
      drawRef.current();
      rafRef.current = requestAnimationFrame(idleLoop);
    };
    rafRef.current = requestAnimationFrame(idleLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase]);

  useEffect(() => {
    if (phaseRef.current === "over" || phaseRef.current === "dying") drawRef.current();
  }, [phase]);

  const handleCanvasClick = useCallback(() => flap(), [flap]);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      style={{
        width: "100%", height: "100%", position: "relative", outline: "none",
        display: "flex", flexDirection: "column", backgroundColor: "#0a0a18",
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
          {score > 0 ? getTheme(score).label : "Space / Click to flap"}
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
          backgroundColor: "#0a0a18",
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
              Flappy Bird
            </div>
            <div onClick={flap} style={{
              padding: "8px 24px", fontSize: 14, fontWeight: 700,
              color: "#0a0a18", backgroundColor: "#5eead4",
              borderRadius: 2, cursor: "pointer", userSelect: "none",
              fontFamily: "monospace", textTransform: "uppercase",
              border: "2px solid #3ac0a8",
            }}>
              Start Game
            </div>
            <div style={{ fontSize: 11, color: "#888", fontFamily: "monospace", textTransform: "uppercase" }}>
              Press Space or Click to Flap
            </div>
          </div>
        )}

        {/* Game over overlay — slides in from below */}
        {phase === "over" && (() => {
          const medal = getMedal(score);
          return (
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
                  minWidth: 140,
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
                  {medal && (
                    <div style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "4px 12px", marginTop: 2,
                      backgroundColor: "rgba(0,0,0,0.4)",
                      border: `2px solid ${medal.border}`,
                      borderRadius: 2,
                    }}>
                      <svg width="18" height="22" viewBox="0 0 18 22" style={{ imageRendering: "pixelated" }}>
                        <rect x="6" y="0" width="6" height="6" fill={medal.color} />
                        <rect x="4" y="2" width="10" height="2" fill={medal.border} />
                        <circle cx="9" cy="14" r="7" fill={medal.color} />
                        <circle cx="9" cy="14" r="5" fill={medal.border} />
                        <circle cx="9" cy="14" r="4" fill={medal.color} />
                        <rect x="7" y="12" width="4" height="4" rx="1" fill={medal.border} opacity="0.6" />
                      </svg>
                      <span style={{
                        fontSize: 14, fontWeight: 700, color: medal.color,
                        fontFamily: "monospace", letterSpacing: 2,
                        textShadow: `1px 1px 0 ${medal.border}`,
                      }}>
                        {medal.name}
                      </span>
                    </div>
                  )}
                </div>

                <div onClick={flap} style={{
                  padding: "8px 24px", fontSize: 14, fontWeight: 700,
                  color: "#0a0a18", backgroundColor: "#5eead4",
                  borderRadius: 2, cursor: "pointer", userSelect: "none",
                  fontFamily: "monospace", textTransform: "uppercase",
                  border: "2px solid #3ac0a8", marginTop: 4,
                }}>
                  Play Again
                </div>
                <div style={{ fontSize: 11, color: "#888", fontFamily: "monospace", textTransform: "uppercase" }}>
                  Press Space or Click
                </div>
              </div>
            </div>
          );
        })()}

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

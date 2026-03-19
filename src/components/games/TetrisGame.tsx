import { useRef, useEffect, useState, useCallback } from "react";

interface TetrisGameProps {
  onAddHighscore: (score: number) => void;
  paused?: boolean;
}

type GamePhase = "idle" | "playing" | "dying" | "over";

/* ---- Grid & canvas constants ---- */
const COLS = 10;
const ROWS = 20;
const CELL = 12;                        // 12×12 pixel cells
const PF_X = 10;                        // playfield left margin in canvas
const PF_Y = 10;                        // playfield top margin
const PF_W = COLS * CELL;               // 120px
const PF_H = ROWS * CELL;              // 240px
const SIDEBAR_X = PF_X + PF_W + 10;   // sidebar starts after playfield + gap
const W = SIDEBAR_X + 70;              // total canvas width (~210)
const H = PF_Y + PF_H + 10;            // total canvas height (~260)
const FRAME_MS = 1000 / 30;

/* ---- Piece definitions (SRS) ---- */
// Each piece has 4 rotation states, each state is 4 [row, col] offsets
type PieceType = "I" | "O" | "T" | "S" | "Z" | "J" | "L";

interface PieceDef {
  rotations: [number, number][][]; // [rotation][block][row, col]
  color: string;
  hi: string;  // highlight (top-left edge)
  sh: string;  // shadow (bottom-right edge)
}

const PIECES: Record<PieceType, PieceDef> = {
  I: {
    rotations: [
      [[1,0],[1,1],[1,2],[1,3]],
      [[0,2],[1,2],[2,2],[3,2]],
      [[2,0],[2,1],[2,2],[2,3]],
      [[0,1],[1,1],[2,1],[3,1]],
    ],
    color: "#00c8d8", hi: "#40e8f0", sh: "#0090a0",
  },
  O: {
    rotations: [
      [[0,1],[0,2],[1,1],[1,2]],
      [[0,1],[0,2],[1,1],[1,2]],
      [[0,1],[0,2],[1,1],[1,2]],
      [[0,1],[0,2],[1,1],[1,2]],
    ],
    color: "#d8c800", hi: "#f0e040", sh: "#a09000",
  },
  T: {
    rotations: [
      [[0,1],[1,0],[1,1],[1,2]],
      [[0,1],[1,1],[1,2],[2,1]],
      [[1,0],[1,1],[1,2],[2,1]],
      [[0,1],[1,0],[1,1],[2,1]],
    ],
    color: "#9830c8", hi: "#b848e0", sh: "#7020a0",
  },
  S: {
    rotations: [
      [[0,1],[0,2],[1,0],[1,1]],
      [[0,1],[1,1],[1,2],[2,2]],
      [[1,1],[1,2],[2,0],[2,1]],
      [[0,0],[1,0],[1,1],[2,1]],
    ],
    color: "#30c830", hi: "#50e850", sh: "#209020",
  },
  Z: {
    rotations: [
      [[0,0],[0,1],[1,1],[1,2]],
      [[0,2],[1,1],[1,2],[2,1]],
      [[1,0],[1,1],[2,1],[2,2]],
      [[0,1],[1,0],[1,1],[2,0]],
    ],
    color: "#d83030", hi: "#f05050", sh: "#a02020",
  },
  J: {
    rotations: [
      [[0,0],[1,0],[1,1],[1,2]],
      [[0,1],[0,2],[1,1],[2,1]],
      [[1,0],[1,1],[1,2],[2,2]],
      [[0,1],[1,1],[2,0],[2,1]],
    ],
    color: "#2848c8", hi: "#4868e0", sh: "#1830a0",
  },
  L: {
    rotations: [
      [[0,2],[1,0],[1,1],[1,2]],
      [[0,1],[1,1],[2,1],[2,2]],
      [[1,0],[1,1],[1,2],[2,0]],
      [[0,0],[0,1],[1,1],[2,1]],
    ],
    color: "#d87820", hi: "#f09840", sh: "#a05810",
  },
};

const PIECE_TYPES: PieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];

/* ---- Scoring ---- */
const LINE_SCORES = [0, 100, 300, 500, 800]; // 0, 1, 2, 3, 4 lines

/* ---- Colors ---- */
const BG = "#0a0a18";
const GRID_LINE = "#141428";
const BORDER_COLOR = "#2a2a40";
const TEXT_COLOR = "#888";
const ACCENT = "#5eead4";

/* ---- Helpers ---- */
function shuffleBag(): PieceType[] {
  const bag = [...PIECE_TYPES];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

function dropSpeed(level: number): number {
  // Frames per cell drop at 30fps. Level 1 = 30 frames (1s), decreases ~15% per level
  return Math.max(2, Math.floor(30 * Math.pow(0.85, level - 1)));
}

/* ---- Component ---- */
export default function TetrisGame({ onAddHighscore, paused = false }: TetrisGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);

  const [phase, setPhase] = useState<GamePhase>("idle");
  const [score, setScore] = useState(0);
  const [lines, setLines] = useState(0);
  const [level, setLevel] = useState(1);
  const [bestScore, setBestScore] = useState(0);
  const [showResults, setShowResults] = useState(false);
  const [containerSize, setContainerSize] = useState({ w: 400, h: 600 });

  const phaseRef = useRef<GamePhase>("idle");
  const pausedRef = useRef(paused);
  const lastTimeRef = useRef(0);
  const accumRef = useRef(0);

  // Game state refs
  const boardRef = useRef<(string | null)[][]>(
    Array.from({ length: ROWS }, () => Array(COLS).fill(null))
  );
  const scoreRef = useRef(0);
  const linesRef = useRef(0);
  const levelRef = useRef(1);
  const bestRef = useRef(0);

  // Current piece state
  const curType = useRef<PieceType>("T");
  const curRot = useRef(0);
  const curRow = useRef(0); // top-left of bounding box
  const curCol = useRef(0);

  // Next piece
  const nextType = useRef<PieceType>("T");

  // Bag randomizer
  const bagRef = useRef<PieceType[]>([]);

  // Drop timing
  const dropTimer = useRef(0);  // frames until next auto-drop
  const lockTimer = useRef(0);  // frames since landed
  const lockDelay = 15;         // 500ms at 30fps = 15 frames

  // Soft drop flag
  const softDropping = useRef(false);

  // DAS (Delayed Auto Shift)
  const dasDir = useRef<"left" | "right" | null>(null);
  const dasTimer = useRef(0);
  const dasActive = useRef(false);
  const DAS_DELAY = 5;   // 170ms at 30fps ~ 5 frames
  const DAS_REPEAT = 2;  // 50ms at 30fps ~ 1.5 frames, use 2

  // Line clear animation
  const clearingRows = useRef<number[]>([]);
  const clearFlashTimer = useRef(0);
  const CLEAR_FLASH_TOTAL = 9; // 3 flashes × 3 frames each

  // Death animation
  const deathRow = useRef(ROWS - 1);
  const deathTimer = useRef(0);
  const flashFrames = useRef(0);

  // Keys currently held
  const keysDown = useRef(new Set<string>());

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  /* ---- Canvas sizing (aspect-fit) ---- */
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

  /* ---- Piece logic helpers ---- */
  function getBlocks(type: PieceType, rot: number): [number, number][] {
    return PIECES[type].rotations[rot % 4];
  }

  function collides(board: (string | null)[][], type: PieceType, rot: number, row: number, col: number): boolean {
    for (const [br, bc] of getBlocks(type, rot)) {
      const r = row + br;
      const c = col + bc;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return true;
      if (board[r][c] !== null) return true;
    }
    return false;
  }

  function ghostRow(board: (string | null)[][], type: PieceType, rot: number, row: number, col: number): number {
    let gr = row;
    while (!collides(board, type, rot, gr + 1, col)) gr++;
    return gr;
  }

  function lockPiece(board: (string | null)[][], type: PieceType, rot: number, row: number, col: number): void {
    const color = PIECES[type].color;
    for (const [br, bc] of getBlocks(type, rot)) {
      const r = row + br;
      const c = col + bc;
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
        board[r][c] = color;
      }
    }
  }

  function findFullRows(board: (string | null)[][]): number[] {
    const full: number[] = [];
    for (let r = 0; r < ROWS; r++) {
      if (board[r].every((c) => c !== null)) full.push(r);
    }
    return full;
  }

  function removeRows(board: (string | null)[][], rows: number[]): void {
    const sorted = [...rows].sort((a, b) => a - b);
    for (let i = sorted.length - 1; i >= 0; i--) {
      board.splice(sorted[i], 1);
    }
    while (board.length < ROWS) {
      board.unshift(Array(COLS).fill(null));
    }
  }

  function nextFromBag(): PieceType {
    if (bagRef.current.length === 0) bagRef.current = shuffleBag();
    return bagRef.current.pop()!;
  }

  function spawnPiece(): boolean {
    curType.current = nextType.current;
    nextType.current = nextFromBag();
    curRot.current = 0;
    curRow.current = curType.current === "I" ? -1 : 0;
    curCol.current = 3;
    dropTimer.current = 0;
    lockTimer.current = 0;
    return !collides(boardRef.current, curType.current, curRot.current, curRow.current, curCol.current);
  }

  /* ---- SRS wall kick data ---- */
  const KICK_DATA: Record<string, [number, number][]> = {
    "0>1": [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
    "1>0": [[0,0],[1,0],[1,-1],[0,2],[1,2]],
    "1>2": [[0,0],[1,0],[1,-1],[0,2],[1,2]],
    "2>1": [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
    "2>3": [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
    "3>2": [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
    "3>0": [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
    "0>3": [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
  };
  const KICK_DATA_I: Record<string, [number, number][]> = {
    "0>1": [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
    "1>0": [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
    "1>2": [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
    "2>1": [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
    "2>3": [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
    "3>2": [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
    "3>0": [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
    "0>3": [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
  };

  function tryRotate(board: (string | null)[][], type: PieceType, fromRot: number, row: number, col: number): { rot: number; row: number; col: number } | null {
    const toRot = (fromRot + 1) % 4;
    const key = `${fromRot}>${toRot}`;
    const kicks = type === "I" ? KICK_DATA_I[key] : KICK_DATA[key];
    if (!kicks) return collides(board, type, toRot, row, col) ? null : { rot: toRot, row, col };
    for (const [dc, dr] of kicks) {
      const nr = row - dr; // SRS: positive dr = up (subtract from row)
      const nc = col + dc;
      if (!collides(board, type, toRot, nr, nc)) {
        return { rot: toRot, row: nr, col: nc };
      }
    }
    return null;
  }

  /* ---- Drawing ---- */
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    // Background
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    // Playfield border
    ctx.fillStyle = BORDER_COLOR;
    ctx.fillRect(PF_X - 1, PF_Y - 1, PF_W + 2, PF_H + 2);

    // Playfield background
    ctx.fillStyle = "#0e0e20";
    ctx.fillRect(PF_X, PF_Y, PF_W, PF_H);

    // Grid lines
    ctx.fillStyle = GRID_LINE;
    for (let c = 1; c < COLS; c++) {
      ctx.fillRect(PF_X + c * CELL, PF_Y, 1, PF_H);
    }
    for (let r = 1; r < ROWS; r++) {
      ctx.fillRect(PF_X, PF_Y + r * CELL, PF_W, 1);
    }

    const board = boardRef.current;

    // Draw locked blocks
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const color = board[r][c];
        if (color) {
          drawBlock(ctx, PF_X + c * CELL, PF_Y + r * CELL, color);
        }
      }
    }

    // Line clear flash overlay
    if (clearingRows.current.length > 0) {
      const flashCycle = Math.floor(clearFlashTimer.current / 3) % 2;
      if (flashCycle === 0) {
        ctx.fillStyle = "#ffffff";
        for (const row of clearingRows.current) {
          ctx.fillRect(PF_X, PF_Y + row * CELL, PF_W, CELL);
        }
      }
    }

    // Draw current piece & ghost (only during play)
    if (phaseRef.current === "playing" && clearingRows.current.length === 0) {
      const type = curType.current;
      const rot = curRot.current;
      const row = curRow.current;
      const col = curCol.current;
      const def = PIECES[type];

      // Ghost piece
      const gr = ghostRow(board, type, rot, row, col);
      if (gr !== row) {
        for (const [br, bc] of getBlocks(type, rot)) {
          const pr = gr + br;
          const pc = col + bc;
          if (pr >= 0 && pr < ROWS && pc >= 0 && pc < COLS) {
            const x = PF_X + pc * CELL;
            const y = PF_Y + pr * CELL;
            ctx.fillStyle = def.color;
            ctx.globalAlpha = 0.25;
            ctx.fillRect(x, y, CELL, CELL);
            ctx.globalAlpha = 1;
            ctx.fillStyle = def.sh;
            ctx.globalAlpha = 0.35;
            ctx.fillRect(x, y, CELL, 1);
            ctx.fillRect(x, y, 1, CELL);
            ctx.fillRect(x + CELL - 1, y, 1, CELL);
            ctx.fillRect(x, y + CELL - 1, CELL, 1);
            ctx.globalAlpha = 1;
          }
        }
      }

      // Active piece
      for (const [br, bc] of getBlocks(type, rot)) {
        const pr = row + br;
        const pc = col + bc;
        if (pr >= 0 && pr < ROWS && pc >= 0 && pc < COLS) {
          drawBlock(ctx, PF_X + pc * CELL, PF_Y + pr * CELL, def.color, def.hi, def.sh);
        }
      }
    }

    // Sidebar
    drawSidebar(ctx);

    // Death flash
    if (flashFrames.current > 0) {
      ctx.fillStyle = "#ffffff";
      ctx.globalAlpha = (flashFrames.current / 6) * 0.7;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  };

  function drawBlock(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, hi?: string, sh?: string) {
    // Main fill
    ctx.fillStyle = color;
    ctx.fillRect(x, y, CELL, CELL);
    // Highlight (top + left edge)
    ctx.fillStyle = hi || lighten(color);
    ctx.fillRect(x, y, CELL, 1);     // top
    ctx.fillRect(x, y, 1, CELL);     // left
    // Shadow (bottom + right edge)
    ctx.fillStyle = sh || darken(color);
    ctx.fillRect(x, y + CELL - 1, CELL, 1);  // bottom
    ctx.fillRect(x + CELL - 1, y, 1, CELL);  // right
    // Inner shine
    ctx.fillStyle = hi || lighten(color);
    ctx.globalAlpha = 0.3;
    ctx.fillRect(x + 1, y + 1, 1, 1);
    ctx.globalAlpha = 1;
  }

  function lighten(hex: string): string {
    const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + 40);
    const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + 40);
    const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + 40);
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }

  function darken(hex: string): string {
    const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - 40);
    const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - 40);
    const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - 40);
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }

  function drawSidebar(ctx: CanvasRenderingContext2D) {
    const sx = SIDEBAR_X;

    // "NEXT" label
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = "bold 10px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("NEXT", sx, PF_Y);

    // Next piece preview box
    const previewX = sx + 4;
    const previewY = PF_Y + 14;
    ctx.fillStyle = "#0e0e20";
    ctx.fillRect(sx, previewY - 2, 60, 40);
    ctx.fillStyle = BORDER_COLOR;
    ctx.fillRect(sx, previewY - 2, 60, 1);
    ctx.fillRect(sx, previewY + 38, 60, 1);
    ctx.fillRect(sx, previewY - 2, 1, 41);
    ctx.fillRect(sx + 59, previewY - 2, 1, 41);

    // Draw next piece centered in preview
    const nt = nextType.current;
    const def = PIECES[nt];
    const blocks = getBlocks(nt, 0);
    // Find bounding box
    let minR = 4, maxR = 0, minC = 4, maxC = 0;
    for (const [br, bc] of blocks) {
      minR = Math.min(minR, br);
      maxR = Math.max(maxR, br);
      minC = Math.min(minC, bc);
      maxC = Math.max(maxC, bc);
    }
    const pw = (maxC - minC + 1) * CELL;
    const ph = (maxR - minR + 1) * CELL;
    const ox = previewX + Math.floor((52 - pw) / 2);
    const oy = previewY + Math.floor((36 - ph) / 2);
    for (const [br, bc] of blocks) {
      drawBlock(ctx, ox + (bc - minC) * CELL, oy + (br - minR) * CELL, def.color, def.hi, def.sh);
    }

    // Score
    const scoreY = previewY + 50;
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = "bold 10px monospace";
    ctx.fillText("SCORE", sx, scoreY);
    ctx.fillStyle = ACCENT;
    ctx.font = "bold 10px monospace";
    ctx.fillText(String(scoreRef.current), sx, scoreY + 14);

    // Lines
    const linesY = scoreY + 36;
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = "bold 10px monospace";
    ctx.fillText("LINES", sx, linesY);
    ctx.fillStyle = "#cccccc";
    ctx.fillText(String(linesRef.current), sx, linesY + 14);

    // Level
    const levelY = linesY + 36;
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = "bold 10px monospace";
    ctx.fillText("LEVEL", sx, levelY);
    ctx.fillStyle = "#cccccc";
    ctx.fillText(String(levelRef.current), sx, levelY + 14);
  }

  /* ---- Init / reset ---- */
  const initGame = useCallback(() => {
    boardRef.current = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    scoreRef.current = 0;
    linesRef.current = 0;
    levelRef.current = 1;
    accumRef.current = 0;
    lastTimeRef.current = 0;
    dropTimer.current = 0;
    lockTimer.current = 0;
    softDropping.current = false;
    dasDir.current = null;
    dasTimer.current = 0;
    dasActive.current = false;
    clearingRows.current = [];
    clearFlashTimer.current = 0;
    deathRow.current = ROWS - 1;
    deathTimer.current = 0;
    flashFrames.current = 0;
    keysDown.current.clear();
    bagRef.current = shuffleBag();
    nextType.current = nextFromBag();
    setScore(0);
    setLines(0);
    setLevel(1);
    setShowResults(false);

    // Spawn first piece
    curType.current = nextFromBag();
    nextType.current = nextFromBag();
    curRot.current = 0;
    curRow.current = curType.current === "I" ? -1 : 0;
    curCol.current = 3;

    phaseRef.current = "playing";
    setPhase("playing");
  }, []);

  /* ---- Move piece left/right ---- */
  function movePiece(dc: number): boolean {
    const newCol = curCol.current + dc;
    if (!collides(boardRef.current, curType.current, curRot.current, curRow.current, newCol)) {
      curCol.current = newCol;
      // Reset lock timer if piece was resting and can now fall further
      if (!collides(boardRef.current, curType.current, curRot.current, curRow.current + 1, curCol.current)) {
        lockTimer.current = 0;
      }
      return true;
    }
    return false;
  }

  /* ---- Hard drop ---- */
  function hardDrop(): void {
    const gr = ghostRow(boardRef.current, curType.current, curRot.current, curRow.current, curCol.current);
    const dropped = gr - curRow.current;
    scoreRef.current += dropped * 2;
    curRow.current = gr;
    placePiece();
  }

  /* ---- Place (lock) current piece ---- */
  function placePiece(): void {
    lockPiece(boardRef.current, curType.current, curRot.current, curRow.current, curCol.current);
    lockTimer.current = 0;

    // Check for line clears
    const fullRows = findFullRows(boardRef.current);
    if (fullRows.length > 0) {
      clearingRows.current = fullRows;
      clearFlashTimer.current = CLEAR_FLASH_TOTAL;
    } else {
      // Spawn next piece immediately
      if (!spawnPiece()) {
        startDying();
      }
    }
  }

  /* ---- Start death sequence ---- */
  const startDying = useCallback(() => {
    if (phaseRef.current === "dying") return;
    phaseRef.current = "dying";
    setPhase("dying");
    flashFrames.current = 6;
    deathRow.current = ROWS - 1;
    deathTimer.current = 0;
    lastTimeRef.current = 0;
    accumRef.current = 0;
  }, []);

  /* ---- Finish death → game over ---- */
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

  /* ---- Handle key action (called from keydown handler) ---- */
  const handleAction = useCallback((action: string) => {
    if (phaseRef.current === "idle") {
      if (action === "start") initGame();
      return;
    }
    if (phaseRef.current === "dying") return;
    if (phaseRef.current === "over") {
      if (action === "start") initGame();
      return;
    }
    if (pausedRef.current) return;
    if (clearingRows.current.length > 0) return; // mid-clear animation

    switch (action) {
      case "left":
        movePiece(-1);
        dasDir.current = "left";
        dasTimer.current = 0;
        dasActive.current = false;
        break;
      case "right":
        movePiece(1);
        dasDir.current = "right";
        dasTimer.current = 0;
        dasActive.current = false;
        break;
      case "rotate":
        {
          const result = tryRotate(boardRef.current, curType.current, curRot.current, curRow.current, curCol.current);
          if (result) {
            curRot.current = result.rot;
            curRow.current = result.row;
            curCol.current = result.col;
            if (!collides(boardRef.current, curType.current, curRot.current, curRow.current + 1, curCol.current)) {
              lockTimer.current = 0;
            }
          }
        }
        break;
      case "softdrop":
        softDropping.current = true;
        break;
      case "harddrop":
        hardDrop();
        break;
    }
  }, [initGame]);

  /* ---- Keyboard: scoped to container div ---- */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Prevent browser scrolling
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) {
        e.preventDefault();
        e.stopPropagation();
      }

      if (keysDown.current.has(e.code)) return; // ignore key repeat from OS
      keysDown.current.add(e.code);

      switch (e.code) {
        case "ArrowLeft":
          handleAction("left");
          break;
        case "ArrowRight":
          handleAction("right");
          break;
        case "ArrowUp":
        case "KeyZ":
          handleAction("rotate");
          break;
        case "ArrowDown":
          handleAction("softdrop");
          break;
        case "Space":
          if (phaseRef.current === "idle" || phaseRef.current === "over") {
            handleAction("start");
          } else {
            handleAction("harddrop");
          }
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keysDown.current.delete(e.code);

      if (e.code === "ArrowDown") {
        softDropping.current = false;
      }
      if (e.code === "ArrowLeft" && dasDir.current === "left") {
        dasDir.current = null;
        dasActive.current = false;
      }
      if (e.code === "ArrowRight" && dasDir.current === "right") {
        dasDir.current = null;
        dasActive.current = false;
      }
    };

    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("keyup", onKeyUp);
    return () => {
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("keyup", onKeyUp);
    };
  }, [handleAction]);

  // Focus container on phase change
  useEffect(() => { containerRef.current?.focus(); }, [phase]);

  // Set canvas native resolution
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = W;
    c.height = H;
  }, []);

  /* ---- Main game loop ---- */
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

        // Line clear animation
        if (clearingRows.current.length > 0) {
          clearFlashTimer.current--;
          if (clearFlashTimer.current <= 0) {
            // Remove cleared rows and award score
            const numCleared = clearingRows.current.length;
            removeRows(boardRef.current, clearingRows.current);
            clearingRows.current = [];

            // Scoring
            const pts = (LINE_SCORES[numCleared] || 0) * levelRef.current;
            scoreRef.current += pts;
            linesRef.current += numCleared;
            setScore(scoreRef.current);
            setLines(linesRef.current);

            // Level up every 10 lines
            const newLevel = Math.floor(linesRef.current / 10) + 1;
            if (newLevel !== levelRef.current) {
              levelRef.current = newLevel;
              setLevel(newLevel);
            }

            // Spawn next piece
            if (!spawnPiece()) {
              startDying();
              drawRef.current();
              return;
            }
          }
          continue; // skip normal game logic during line clear
        }

        // DAS auto-repeat
        if (dasDir.current) {
          dasTimer.current++;
          if (!dasActive.current && dasTimer.current >= DAS_DELAY) {
            dasActive.current = true;
            dasTimer.current = 0;
          }
          if (dasActive.current) {
            dasTimer.current++;
            if (dasTimer.current >= DAS_REPEAT) {
              dasTimer.current = 0;
              movePiece(dasDir.current === "left" ? -1 : 1);
            }
          }
        }

        // Gravity / drop
        const speed = softDropping.current ? 2 : dropSpeed(levelRef.current);
        dropTimer.current++;

        if (dropTimer.current >= speed) {
          dropTimer.current = 0;

          // Try to move piece down
          if (!collides(boardRef.current, curType.current, curRot.current, curRow.current + 1, curCol.current)) {
            curRow.current++;
            if (softDropping.current) {
              scoreRef.current += 1;
              setScore(scoreRef.current);
            }
            lockTimer.current = 0;
          } else {
            // Piece is resting on something
            lockTimer.current++;
            if (lockTimer.current >= lockDelay) {
              placePiece();
              if (phaseRef.current !== "playing") {
                drawRef.current();
                return;
              }
            }
          }
        } else {
          // Even if not dropping this frame, check if piece should lock
          if (collides(boardRef.current, curType.current, curRot.current, curRow.current + 1, curCol.current)) {
            lockTimer.current++;
            if (lockTimer.current >= lockDelay) {
              placePiece();
              if (phaseRef.current !== "playing") {
                drawRef.current();
                return;
              }
            }
          }
        }
      }

      drawRef.current();
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, startDying]);

  /* ---- Death animation: board fills with grey from bottom ---- */
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

        deathTimer.current++;
        // Every 2 frames, fill one row from bottom with grey
        if (deathTimer.current % 2 === 0 && deathRow.current >= 0) {
          for (let c = 0; c < COLS; c++) {
            boardRef.current[deathRow.current][c] = "#404058";
          }
          deathRow.current--;
        }

        // Once all rows filled, wait a beat then show results
        if (deathRow.current < 0 && deathTimer.current > ROWS * 2 + 15) {
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

  /* ---- Slide in results panel ---- */
  useEffect(() => {
    if (phase === "over") {
      const timer = setTimeout(() => setShowResults(true), 50);
      return () => clearTimeout(timer);
    }
    setShowResults(false);
  }, [phase]);

  /* ---- Idle animation: pieces falling in background ---- */
  useEffect(() => {
    if (phaseRef.current !== "idle") return;

    // Fill board with a subtle pattern for visual interest
    const idleBoard = boardRef.current;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        idleBoard[r][c] = null;
      }
    }

    let idleFrame = 0;
    const idlePiece = { type: PIECE_TYPES[0], rot: 0, row: -4, col: 3 };

    const idleLoop = () => {
      if (phaseRef.current !== "idle") return;

      idleFrame++;
      // Slowly drop a demo piece
      if (idleFrame % 15 === 0) {
        idlePiece.row++;
        if (idlePiece.row > ROWS + 2) {
          idlePiece.row = -4;
          idlePiece.type = PIECE_TYPES[Math.floor(Math.random() * 7)];
          idlePiece.rot = Math.floor(Math.random() * 4);
          idlePiece.col = Math.floor(Math.random() * 7) + 1;
        }
      }

      // Draw idle state
      const canvas = canvasRef.current;
      if (!canvas) { rafRef.current = requestAnimationFrame(idleLoop); return; }
      const ctx = canvas.getContext("2d");
      if (!ctx) { rafRef.current = requestAnimationFrame(idleLoop); return; }
      ctx.imageSmoothingEnabled = false;

      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);

      // Playfield border
      ctx.fillStyle = BORDER_COLOR;
      ctx.fillRect(PF_X - 1, PF_Y - 1, PF_W + 2, PF_H + 2);
      ctx.fillStyle = "#0e0e20";
      ctx.fillRect(PF_X, PF_Y, PF_W, PF_H);

      // Grid
      ctx.fillStyle = GRID_LINE;
      for (let c = 1; c < COLS; c++) ctx.fillRect(PF_X + c * CELL, PF_Y, 1, PF_H);
      for (let r = 1; r < ROWS; r++) ctx.fillRect(PF_X, PF_Y + r * CELL, PF_W, 1);

      // Demo piece
      const def = PIECES[idlePiece.type as PieceType];
      for (const [br, bc] of getBlocks(idlePiece.type as PieceType, idlePiece.rot)) {
        const pr = idlePiece.row + br;
        const pc = idlePiece.col + bc;
        if (pr >= 0 && pr < ROWS && pc >= 0 && pc < COLS) {
          ctx.globalAlpha = 0.3;
          drawBlock(ctx, PF_X + pc * CELL, PF_Y + pr * CELL, def.color, def.hi, def.sh);
          ctx.globalAlpha = 1;
        }
      }

      // Sidebar placeholder
      drawSidebar(ctx);

      rafRef.current = requestAnimationFrame(idleLoop);
    };

    rafRef.current = requestAnimationFrame(idleLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase]);

  // Redraw on phase transitions for dying/over
  useEffect(() => {
    if (phaseRef.current === "over" || phaseRef.current === "dying") drawRef.current();
  }, [phase]);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      style={{
        width: "100%", height: "100%", position: "relative", outline: "none",
        display: "flex", flexDirection: "column", backgroundColor: BG,
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
          {phase === "idle" ? "Space to start" : `Level ${level}`}
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
          backgroundColor: BG,
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
              Tetris
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
              Press Space to Start
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
                  fontSize: 36, fontWeight: 700, color: ACCENT,
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
                  fontSize: 11, fontFamily: "monospace", color: "#aaa",
                }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ color: "#666", fontSize: 9, textTransform: "uppercase" }}>Lines</div>
                    <div>{lines}</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ color: "#666", fontSize: 9, textTransform: "uppercase" }}>Level</div>
                    <div>{level}</div>
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
                Press Space to Retry
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

import { useState, useEffect, useCallback, useRef } from "react";

interface MemoryGameProps {
  onAddTimedHighscore: (game: "memoryEasy" | "memoryMedium" | "memoryHard", seconds: number) => void;
  paused?: boolean;
}

type Difficulty = "easy" | "medium" | "hard";
type GamePhase = "select" | "playing" | "won";

interface MemoryCard {
  id: number;
  symbolIndex: number;
  flipped: boolean;
  matched: boolean;
}

interface DifficultyConfig {
  cols: number;
  rows: number;
  pairs: number;
  label: string;
  description: string;
  highscoreKey: "memoryEasy" | "memoryMedium" | "memoryHard";
}

const DIFFICULTIES: Record<Difficulty, DifficultyConfig> = {
  easy: { cols: 4, rows: 4, pairs: 8, label: "Easy", description: "4x4 grid, 8 pairs", highscoreKey: "memoryEasy" },
  medium: { cols: 5, rows: 4, pairs: 10, label: "Medium", description: "5x4 grid, 10 pairs", highscoreKey: "memoryMedium" },
  hard: { cols: 6, rows: 5, pairs: 15, label: "Hard", description: "6x5 grid, 15 pairs", highscoreKey: "memoryHard" },
};

/* ── SVG Symbol Components ─────────────────────────────────── */

function SymbolCircle({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <circle cx={20} cy={20} r={14} fill={color} />
    </svg>
  );
}

function SymbolDiamond({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <polygon points="20,4 34,20 20,36 6,20" fill={color} />
    </svg>
  );
}

function SymbolTriangle({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <polygon points="20,5 35,34 5,34" fill={color} />
    </svg>
  );
}

function SymbolSquareRotated({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <rect x={10} y={10} width={20} height={20} rx={2} fill={color} transform="rotate(45 20 20)" />
    </svg>
  );
}

function SymbolStar({ size, color }: { size: number; color: string }) {
  // 5-point star
  const cx = 20, cy = 20, outerR = 15, innerR = 7;
  const points: string[] = [];
  for (let i = 0; i < 5; i++) {
    const outerAngle = (Math.PI / 2) + (2 * Math.PI * i) / 5;
    const innerAngle = outerAngle + Math.PI / 5;
    points.push(`${cx - Math.cos(outerAngle) * outerR},${cy - Math.sin(outerAngle) * outerR}`);
    points.push(`${cx - Math.cos(innerAngle) * innerR},${cy - Math.sin(innerAngle) * innerR}`);
  }
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <polygon points={points.join(" ")} fill={color} />
    </svg>
  );
}

function SymbolHexagon({ size, color }: { size: number; color: string }) {
  const cx = 20, cy = 20, r = 15;
  const points: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    points.push(`${cx + Math.cos(angle) * r},${cy + Math.sin(angle) * r}`);
  }
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <polygon points={points.join(" ")} fill={color} />
    </svg>
  );
}

function SymbolCross({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <rect x={15} y={6} width={10} height={28} rx={2} fill={color} />
      <rect x={6} y={15} width={28} height={10} rx={2} fill={color} />
    </svg>
  );
}

function SymbolHeart({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <path
        d="M20 34 C10 26, 2 20, 6 12 C8 8, 14 6, 20 14 C26 6, 32 8, 34 12 C38 20, 30 26, 20 34Z"
        fill={color}
      />
    </svg>
  );
}

function SymbolPentagon({ size, color }: { size: number; color: string }) {
  const cx = 20, cy = 21, r = 15;
  const points: string[] = [];
  for (let i = 0; i < 5; i++) {
    const angle = (2 * Math.PI * i) / 5 - Math.PI / 2;
    points.push(`${cx + Math.cos(angle) * r},${cy + Math.sin(angle) * r}`);
  }
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <polygon points={points.join(" ")} fill={color} />
    </svg>
  );
}

function SymbolMoon({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <path
        d="M24 6 C16 10, 14 20, 18 28 C20 32, 24 34, 28 34 C18 36, 6 28, 6 18 C6 8, 14 2, 24 6Z"
        fill={color}
      />
    </svg>
  );
}

function SymbolArrowUp({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <polygon points="20,4 32,22 24,22 24,36 16,36 16,22 8,22" fill={color} />
    </svg>
  );
}

function SymbolLightning({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <polygon points="22,4 10,22 18,22 16,36 30,16 22,16" fill={color} />
    </svg>
  );
}

function SymbolSpiral({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <path
        d="M20 20 C20 16, 24 14, 26 16 C30 20, 28 26, 22 28 C14 30, 8 24, 10 16 C12 6, 24 4, 30 12 C36 22, 30 34, 18 34"
        stroke={color}
        strokeWidth={3}
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function SymbolOctagon({ size, color }: { size: number; color: string }) {
  const cx = 20, cy = 20, r = 15;
  const points: string[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI / 4) * i - Math.PI / 8;
    points.push(`${cx + Math.cos(angle) * r},${cy + Math.sin(angle) * r}`);
  }
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <polygon points={points.join(" ")} fill={color} />
    </svg>
  );
}

function SymbolChevronDouble({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <polyline points="10,10 20,20 30,10" stroke={color} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <polyline points="10,22 20,32 30,22" stroke={color} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

const SYMBOL_COMPONENTS: React.FC<{ size: number; color: string }>[] = [
  SymbolCircle,
  SymbolSquareRotated,
  SymbolTriangle,
  SymbolDiamond,
  SymbolStar,
  SymbolHexagon,
  SymbolCross,
  SymbolHeart,
  SymbolPentagon,
  SymbolMoon,
  SymbolArrowUp,
  SymbolLightning,
  SymbolSpiral,
  SymbolOctagon,
  SymbolChevronDouble,
];

/* ── Utility Functions ─────────────────────────────────────── */

function fisherYatesShuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createCards(pairs: number): MemoryCard[] {
  const indices: number[] = [];
  for (let i = 0; i < pairs; i++) {
    indices.push(i, i);
  }
  const shuffled = fisherYatesShuffle(indices);
  return shuffled.map((symbolIndex, id) => ({
    id,
    symbolIndex,
    flipped: false,
    matched: false,
  }));
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/* ── Main Component ────────────────────────────────────────── */

export default function MemoryGame({ onAddTimedHighscore, paused = false }: MemoryGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gridAreaRef = useRef<HTMLDivElement>(null);

  const [difficulty, setDifficulty] = useState<Difficulty | null>(null);
  const [phase, setPhase] = useState<GamePhase>("select");
  const [cards, setCards] = useState<MemoryCard[]>([]);
  const [moves, setMoves] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [cursorIdx, setCursorIdx] = useState(0);
  const [containerSize, setContainerSize] = useState({ w: 400, h: 300 });

  // Refs for values accessed inside callbacks/timers
  const phaseRef = useRef<GamePhase>("select");
  const elapsedRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const timerStartedRef = useRef(false);
  const flippedIdsRef = useRef<number[]>([]);
  const checkingRef = useRef(false); // true while waiting for mismatch delay
  const cardsRef = useRef<MemoryCard[]>([]);
  const movesRef = useRef(0);
  const difficultyRef = useRef<Difficulty | null>(null);

  // Sync refs
  phaseRef.current = phase;
  cardsRef.current = cards;
  movesRef.current = moves;
  difficultyRef.current = difficulty;

  /* ── ResizeObserver ────────────────────────────────────── */
  useEffect(() => {
    const el = gridAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setContainerSize({ w: Math.floor(width), h: Math.floor(height) });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ── Timer ─────────────────────────────────────────────── */
  useEffect(() => {
    if (phase === "playing" && !paused && timerStartedRef.current) {
      timerRef.current = setInterval(() => {
        elapsedRef.current += 1;
        setElapsed(elapsedRef.current);
      }, 1000);
    }
    return () => {
      if (timerRef.current !== undefined) {
        clearInterval(timerRef.current);
        timerRef.current = undefined;
      }
    };
  }, [phase, paused]);

  /* ── Focus on phase changes ────────────────────────────── */
  useEffect(() => {
    containerRef.current?.focus();
  }, [phase]);

  /* ── Start Game ────────────────────────────────────────── */
  const startGame = useCallback((diff: Difficulty) => {
    const cfg = DIFFICULTIES[diff];
    const newCards = createCards(cfg.pairs);
    setDifficulty(diff);
    setCards(newCards);
    setPhase("playing");
    phaseRef.current = "playing";
    setMoves(0);
    movesRef.current = 0;
    setElapsed(0);
    elapsedRef.current = 0;
    timerStartedRef.current = false;
    flippedIdsRef.current = [];
    checkingRef.current = false;
    setCursorIdx(0);
    setTimeout(() => containerRef.current?.focus(), 50);
  }, []);

  /* ── Card Click Handler ────────────────────────────────── */
  const handleCardClick = useCallback((cardId: number) => {
    if (paused) return;
    if (phaseRef.current !== "playing") return;
    if (checkingRef.current) return;

    const currentCards = cardsRef.current;
    const card = currentCards.find((c) => c.id === cardId);
    if (!card) return;
    if (card.flipped || card.matched) return;

    // Start timer on first flip
    if (!timerStartedRef.current) {
      timerStartedRef.current = true;
      // Trigger timer effect by re-setting phase (already "playing")
      // We need to force the timer useEffect to re-run
      setElapsed(0);
      elapsedRef.current = 0;
      // Start timer manually here since the effect might not re-trigger
      if (timerRef.current !== undefined) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        elapsedRef.current += 1;
        setElapsed(elapsedRef.current);
      }, 1000);
    }

    // Flip the card
    const updated = currentCards.map((c) =>
      c.id === cardId ? { ...c, flipped: true } : c
    );
    setCards(updated);
    cardsRef.current = updated;

    const flipped = [...flippedIdsRef.current, cardId];
    flippedIdsRef.current = flipped;

    if (flipped.length === 2) {
      // Two cards flipped — increment moves
      const newMoves = movesRef.current + 1;
      setMoves(newMoves);
      movesRef.current = newMoves;

      const [firstId, secondId] = flipped;
      const first = updated.find((c) => c.id === firstId)!;
      const second = updated.find((c) => c.id === secondId)!;

      if (first.symbolIndex === second.symbolIndex) {
        // Match
        const matched = updated.map((c) =>
          c.id === firstId || c.id === secondId
            ? { ...c, matched: true }
            : c
        );
        setCards(matched);
        cardsRef.current = matched;
        flippedIdsRef.current = [];

        // Check win
        if (matched.every((c) => c.matched)) {
          phaseRef.current = "won";
          setPhase("won");
          if (timerRef.current !== undefined) {
            clearInterval(timerRef.current);
            timerRef.current = undefined;
          }
          const diff = difficultyRef.current;
          if (diff) {
            onAddTimedHighscore(DIFFICULTIES[diff].highscoreKey, elapsedRef.current);
          }
        }
      } else {
        // No match — flip back after delay
        checkingRef.current = true;
        setTimeout(() => {
          const current = cardsRef.current;
          const reverted = current.map((c) =>
            c.id === firstId || c.id === secondId
              ? { ...c, flipped: false }
              : c
          );
          setCards(reverted);
          cardsRef.current = reverted;
          flippedIdsRef.current = [];
          checkingRef.current = false;
        }, 600);
      }
    }
  }, [paused, onAddTimedHighscore]);

  /* ── Keyboard Navigation ───────────────────────────────── */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (phaseRef.current !== "playing") return;
    if (paused) return;

    const diff = difficultyRef.current;
    if (!diff) return;
    const cfg = DIFFICULTIES[diff];
    const totalCards = cfg.cols * cfg.rows;

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        setCursorIdx((prev) => {
          const newIdx = prev - cfg.cols;
          return newIdx >= 0 ? newIdx : prev;
        });
        break;
      case "ArrowDown":
        e.preventDefault();
        setCursorIdx((prev) => {
          const newIdx = prev + cfg.cols;
          return newIdx < totalCards ? newIdx : prev;
        });
        break;
      case "ArrowLeft":
        e.preventDefault();
        setCursorIdx((prev) => (prev > 0 ? prev - 1 : prev));
        break;
      case "ArrowRight":
        e.preventDefault();
        setCursorIdx((prev) => (prev < totalCards - 1 ? prev + 1 : prev));
        break;
      case "Enter":
        e.preventDefault();
        {
          const currentCards = cardsRef.current;
          if (cursorIdx >= 0 && cursorIdx < currentCards.length) {
            handleCardClick(currentCards[cursorIdx].id);
          }
        }
        break;
    }
  }, [paused, cursorIdx, handleCardClick]);

  /* ── Reset Handlers ────────────────────────────────────── */
  const handleNewGame = useCallback(() => {
    if (difficulty) startGame(difficulty);
  }, [difficulty, startGame]);

  const handleBackToSelect = useCallback(() => {
    setPhase("select");
    phaseRef.current = "select";
    setDifficulty(null);
    setCards([]);
    setMoves(0);
    setElapsed(0);
    elapsedRef.current = 0;
    timerStartedRef.current = false;
    flippedIdsRef.current = [];
    checkingRef.current = false;
    if (timerRef.current !== undefined) {
      clearInterval(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  /* ── Difficulty Select Screen ──────────────────────────── */
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
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 12,
          fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ezy-text)", marginBottom: 8 }}>
          Select Difficulty
        </div>
        {(["easy", "medium", "hard"] as Difficulty[]).map((d) => {
          const cfg = DIFFICULTIES[d];
          return (
            <div
              key={d}
              onClick={() => startGame(d)}
              style={{
                width: "100%",
                maxWidth: 260,
                padding: "12px 16px",
                borderRadius: 6,
                backgroundColor: "var(--ezy-surface)",
                border: "1px solid var(--ezy-border)",
                cursor: "pointer",
                transition: "background-color 150ms ease, border-color 150ms ease",
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
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>{cfg.label}</div>
              <div style={{ fontSize: 11, color: "var(--ezy-text-secondary)", marginTop: 2 }}>{cfg.description}</div>
            </div>
          );
        })}
      </div>
    );
  }

  /* ── Playing / Won Screen ──────────────────────────────── */
  const cfg = difficulty ? DIFFICULTIES[difficulty] : null;
  if (!cfg) return null;

  // Responsive card sizing
  const gridGap = 6;
  const containerPadding = 16;
  const availW = containerSize.w - containerPadding * 2;
  const availH = containerSize.h - containerPadding * 2;
  const maxByW = (availW - gridGap * (cfg.cols - 1)) / cfg.cols;
  const maxByH = (availH - gridGap * (cfg.rows - 1)) / cfg.rows;
  const cardSize = Math.max(40, Math.min(100, Math.floor(Math.min(maxByW, maxByH))));
  // Symbol size is ~55% of card
  const symbolSize = Math.max(16, Math.floor(cardSize * 0.55));

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        width: "100%",
        height: "100%",
        outline: "none",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--ezy-bg)",
        fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)",
      }}
    >
      {/* Score bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--ezy-text-secondary)",
          borderBottom: "1px solid var(--ezy-border)",
          fontVariantNumeric: "tabular-nums",
          padding: "6px 12px",
          flexShrink: 0,
          fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)",
        }}
      >
        <span>Moves: {moves}</span>
        <span>Time: {formatTime(elapsed)}</span>
        <span>{cfg.label}</span>
      </div>

      {/* Grid area */}
      <div
        ref={gridAreaRef}
        data-canvas-area
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          position: "relative",
          padding: containerPadding,
        }}
      >
        {/* Card grid */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${cfg.cols}, ${cardSize}px)`,
            gap: gridGap,
            perspective: 600,
          }}
        >
          {cards.map((card, idx) => {
            const isFaceUp = card.flipped || card.matched;
            const isCursor = idx === cursorIdx;
            const SymbolComp = SYMBOL_COMPONENTS[card.symbolIndex];

            return (
              <div
                key={card.id}
                onClick={() => handleCardClick(card.id)}
                style={{
                  width: cardSize,
                  height: cardSize,
                  cursor: card.matched ? "default" : "pointer",
                  outline: isCursor ? "2px solid var(--ezy-accent)" : "none",
                  outlineOffset: -2,
                  position: "relative",
                  zIndex: isCursor ? 1 : 0,
                  perspective: 600,
                }}
              >
                {/* Inner card — handles flip transform */}
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    position: "relative",
                    transformStyle: "preserve-3d",
                    transition: "transform 0.4s ease",
                    transform: isFaceUp ? "rotateY(180deg)" : "rotateY(0deg)",
                  }}
                >
                  {/* Front face (face-down) */}
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      backfaceVisibility: "hidden",
                      WebkitBackfaceVisibility: "hidden",
                      backgroundColor: "var(--ezy-surface-raised)",
                      border: "1px solid var(--ezy-border)",
                      borderRadius: 6,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: Math.max(14, cardSize * 0.35),
                      fontWeight: 700,
                      color: "var(--ezy-text-muted)",
                      userSelect: "none",
                    }}
                  >
                    ?
                  </div>

                  {/* Back face (face-up — symbol) */}
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      backfaceVisibility: "hidden",
                      WebkitBackfaceVisibility: "hidden",
                      transform: "rotateY(180deg)",
                      backgroundColor: "var(--ezy-bg)",
                      border: card.matched
                        ? "1px solid var(--ezy-accent)"
                        : "1px solid var(--ezy-border)",
                      borderRadius: 6,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {SymbolComp && <SymbolComp size={symbolSize} color="var(--ezy-accent)" />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Won overlay */}
        {phase === "won" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor: "rgba(0,0,0,0.75)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              zIndex: 10,
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, color: "#4ade80" }}>
              Completed!
            </div>
            <div style={{ fontSize: 13, color: "var(--ezy-text-secondary)", fontVariantNumeric: "tabular-nums" }}>
              Moves: {moves}
            </div>
            <div style={{ fontSize: 13, color: "var(--ezy-text-secondary)", fontVariantNumeric: "tabular-nums" }}>
              Time: {formatTime(elapsed)}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <div
                onClick={handleNewGame}
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  padding: "8px 20px",
                  borderRadius: 6,
                  backgroundColor: "var(--ezy-accent)",
                  color: "var(--ezy-bg)",
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
                onClick={handleBackToSelect}
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  padding: "8px 20px",
                  borderRadius: 6,
                  color: "var(--ezy-text-secondary)",
                  backgroundColor: "var(--ezy-surface)",
                  border: "1px solid var(--ezy-border)",
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
              backgroundColor: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10,
            }}
          >
            <span style={{ fontSize: 16, fontWeight: 700, color: "var(--ezy-text-muted)", fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)" }}>
              Paused
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

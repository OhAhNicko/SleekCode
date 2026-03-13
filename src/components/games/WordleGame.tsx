import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { TECH_WORDS, CLASSIC_WORDS, VALID_GUESSES } from "../../lib/wordle-words";

interface WordleGameProps {
  onUpdateStats: (mode: "tech" | "classic", won: boolean) => void;
  paused?: boolean;
}

type TileState = "empty" | "tbd" | "correct" | "present" | "absent";
type Mode = "tech" | "classic";

const WORD_LENGTH = 5;
const MAX_GUESSES = 6;

// Simple seeded PRNG (mulberry32)
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getDayNumber(): number {
  return Math.floor(Date.now() / 86400000);
}

function getDailyWord(mode: Mode): string {
  const words = mode === "tech" ? TECH_WORDS : CLASSIC_WORDS;
  const seed = getDayNumber() * 31 + (mode === "tech" ? 7 : 13);
  const rng = mulberry32(seed);
  return words[Math.floor(rng() * words.length)];
}

function getValidWords(mode: Mode): Set<string> {
  const set = new Set<string>();
  for (const w of TECH_WORDS) set.add(w);
  for (const w of CLASSIC_WORDS) set.add(w);
  for (const w of VALID_GUESSES) set.add(w);
  // In tech mode, also accept tech words; in classic, accept classic
  // All lists are valid for guessing in both modes
  void mode;
  return set;
}

function evaluateGuess(guess: string, answer: string): TileState[] {
  const result: TileState[] = Array(WORD_LENGTH).fill("absent");
  const answerChars = answer.split("");
  const guessChars = guess.split("");
  const used = Array(WORD_LENGTH).fill(false);

  // First pass: correct positions
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guessChars[i] === answerChars[i]) {
      result[i] = "correct";
      used[i] = true;
    }
  }

  // Second pass: present but wrong position
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (result[i] === "correct") continue;
    for (let j = 0; j < WORD_LENGTH; j++) {
      if (!used[j] && guessChars[i] === answerChars[j]) {
        result[i] = "present";
        used[j] = true;
        break;
      }
    }
  }

  return result;
}

const KEYBOARD_ROWS = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["ENTER", "Z", "X", "C", "V", "B", "N", "M", "BACK"],
];

const TILE_COLORS: Record<TileState, { bg: string; color: string }> = {
  empty: { bg: "var(--ezy-surface)", color: "transparent" },
  tbd: { bg: "var(--ezy-surface)", color: "var(--ezy-text)" },
  correct: { bg: "#4ade80", color: "#000" },
  present: { bg: "var(--ezy-accent)", color: "var(--ezy-bg)" },
  absent: { bg: "var(--ezy-surface-raised)", color: "var(--ezy-text-muted)" },
};

interface DayState {
  guesses: string[];
  evaluations: TileState[][];
  completed: boolean;
  won: boolean;
}

function loadDayState(mode: Mode, dayNum: number): DayState | null {
  try {
    const raw = localStorage.getItem(`ezydev-wordle-${mode}-${dayNum}`);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

function saveDayState(mode: Mode, dayNum: number, state: DayState) {
  localStorage.setItem(`ezydev-wordle-${mode}-${dayNum}`, JSON.stringify(state));
}

export default function WordleGame({ onUpdateStats, paused = false }: WordleGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("tech");
  const [containerWidth, setContainerWidth] = useState(400);

  const dayNum = useMemo(() => getDayNumber(), []);
  const answer = useMemo(() => getDailyWord(mode), [mode, dayNum]);
  const validWords = useMemo(() => getValidWords(mode), [mode]);

  const [guesses, setGuesses] = useState<string[]>([]);
  const [evaluations, setEvaluations] = useState<TileState[][]>([]);
  const [currentGuess, setCurrentGuess] = useState("");
  const [completed, setCompleted] = useState(false);
  const [won, setWon] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [revealingRow, setRevealingRow] = useState(-1);
  const [countdown, setCountdown] = useState("");
  const statsReportedRef = useRef(false);

  // Load saved state for this day/mode
  useEffect(() => {
    statsReportedRef.current = false;
    const saved = loadDayState(mode, dayNum);
    if (saved) {
      setGuesses(saved.guesses);
      setEvaluations(saved.evaluations);
      setCompleted(saved.completed);
      setWon(saved.won);
      setCurrentGuess("");
    } else {
      setGuesses([]);
      setEvaluations([]);
      setCompleted(false);
      setWon(false);
      setCurrentGuess("");
    }
  }, [mode, dayNum]);

  // Countdown timer when completed
  useEffect(() => {
    if (!completed) return;
    const update = () => {
      const now = Date.now();
      const nextDay = (dayNum + 1) * 86400000;
      const diff = Math.max(0, nextDay - now);
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCountdown(`${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`);
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [completed, dayNum]);

  // ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build keyboard letter states
  const keyStates = useMemo(() => {
    const states: Record<string, TileState> = {};
    for (let g = 0; g < guesses.length; g++) {
      const word = guesses[g];
      const eval_ = evaluations[g];
      if (!eval_) continue;
      for (let i = 0; i < WORD_LENGTH; i++) {
        const letter = word[i];
        const state = eval_[i];
        const current = states[letter];
        // Priority: correct > present > absent
        if (state === "correct") states[letter] = "correct";
        else if (state === "present" && current !== "correct") states[letter] = "present";
        else if (state === "absent" && !current) states[letter] = "absent";
      }
    }
    return states;
  }, [guesses, evaluations]);

  const submitGuess = useCallback(() => {
    if (completed || currentGuess.length !== WORD_LENGTH) return;
    const guess = currentGuess.toUpperCase();

    if (!validWords.has(guess)) {
      setShaking(true);
      setTimeout(() => setShaking(false), 600);
      return;
    }

    const eval_ = evaluateGuess(guess, answer);
    const newGuesses = [...guesses, guess];
    const newEvals = [...evaluations, eval_];
    const isWin = eval_.every((s) => s === "correct");
    const isLoss = !isWin && newGuesses.length >= MAX_GUESSES;
    const isDone = isWin || isLoss;

    setRevealingRow(guesses.length);
    setTimeout(() => setRevealingRow(-1), WORD_LENGTH * 100 + 300);

    setGuesses(newGuesses);
    setEvaluations(newEvals);
    setCurrentGuess("");

    if (isDone) {
      setCompleted(true);
      setWon(isWin);
      if (!statsReportedRef.current) {
        statsReportedRef.current = true;
        onUpdateStats(mode, isWin);
      }
    }

    saveDayState(mode, dayNum, {
      guesses: newGuesses,
      evaluations: newEvals,
      completed: isDone,
      won: isWin,
    });
  }, [currentGuess, guesses, evaluations, answer, validWords, completed, mode, dayNum, onUpdateStats]);

  const handleKey = useCallback((key: string) => {
    if (completed || paused) return;

    if (key === "ENTER") {
      submitGuess();
    } else if (key === "BACK" || key === "BACKSPACE") {
      setCurrentGuess((g) => g.slice(0, -1));
    } else if (/^[A-Z]$/.test(key) && currentGuess.length < WORD_LENGTH) {
      setCurrentGuess((g) => g + key);
    }
  }, [completed, paused, currentGuess, submitGuess]);

  // Physical keyboard — scoped to container so keys don't steal from CLI panes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toUpperCase();
      if (key === "ENTER" || key === "BACKSPACE" || /^[A-Z]$/.test(key)) {
        e.preventDefault();
        handleKey(key);
      }
    };
    container.addEventListener("keydown", handler);
    return () => container.removeEventListener("keydown", handler);
  }, [handleKey]);

  useEffect(() => { containerRef.current?.focus(); }, [mode]);

  const tileSize = Math.max(32, Math.min(52, Math.floor((containerWidth - 60) / WORD_LENGTH)));
  const tileGap = Math.max(3, Math.floor(tileSize * 0.08));
  const keyWidth = Math.max(24, Math.min(34, Math.floor((containerWidth - 40) / 10)));
  const keyHeight = Math.floor(keyWidth * 1.4);

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
      <style>{`
        @keyframes wordle-shake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
          20%, 40%, 60%, 80% { transform: translateX(4px); }
        }
        @keyframes wordle-flip {
          0% { transform: scaleY(1); }
          50% { transform: scaleY(0); }
          100% { transform: scaleY(1); }
        }
        @keyframes wordle-pop {
          0% { transform: scale(1); }
          50% { transform: scale(1.12); }
          100% { transform: scale(1); }
        }
      `}</style>

      {/* Score bar with mode toggle */}
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
          gap: 8,
        }}
      >
        {/* Mode pills */}
        <div style={{ display: "flex", gap: 4 }}>
          {(["tech", "classic"] as Mode[]).map((m) => (
            <div
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: "2px 10px",
                borderRadius: 10,
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
                backgroundColor: mode === m ? "var(--ezy-accent)" : "var(--ezy-surface)",
                color: mode === m ? "var(--ezy-bg)" : "var(--ezy-text-secondary)",
                transition: "background-color 150ms ease, color 150ms ease",
              }}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </div>
          ))}
        </div>
        {completed && (
          <span style={{ fontSize: 10, color: "var(--ezy-text-muted)" }}>
            Next: {countdown}
          </span>
        )}
      </div>

      {/* Grid area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: "8px 0" }}>
        {/* Tile grid */}
        <div style={{ display: "flex", flexDirection: "column", gap: tileGap }}>
          {Array.from({ length: MAX_GUESSES }).map((_, rowIdx) => {
            const isCurrentRow = rowIdx === guesses.length && !completed;
            const word = rowIdx < guesses.length ? guesses[rowIdx] : isCurrentRow ? currentGuess : "";
            const eval_ = rowIdx < evaluations.length ? evaluations[rowIdx] : null;
            const isRevealing = revealingRow === rowIdx;
            const isShakingRow = isCurrentRow && shaking;

            return (
              <div
                key={rowIdx}
                style={{
                  display: "flex",
                  gap: tileGap,
                  justifyContent: "center",
                  animation: isShakingRow ? "wordle-shake 600ms ease" : "none",
                }}
              >
                {Array.from({ length: WORD_LENGTH }).map((_, colIdx) => {
                  const letter = word[colIdx] || "";
                  const state: TileState = eval_ ? eval_[colIdx] : letter ? "tbd" : "empty";
                  const colors = TILE_COLORS[state];
                  const revealDelay = isRevealing ? colIdx * 100 : 0;

                  return (
                    <div
                      key={colIdx}
                      style={{
                        width: tileSize,
                        height: tileSize,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: colors.bg,
                        color: colors.color,
                        fontSize: Math.floor(tileSize * 0.45),
                        fontWeight: 700,
                        borderRadius: 4,
                        border: state === "tbd" || state === "empty" ? "1px solid var(--ezy-border)" : "none",
                        animation: isRevealing && eval_
                          ? `wordle-flip 400ms ease ${revealDelay}ms`
                          : state === "tbd" && letter
                            ? "wordle-pop 100ms ease"
                            : "none",
                        fontFamily: "system-ui, sans-serif",
                        textTransform: "uppercase",
                      }}
                    >
                      {letter}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Result message */}
        {completed && (
          <div style={{ textAlign: "center", padding: "4px 0" }}>
            <div style={{
              fontSize: 14,
              fontWeight: 700,
              color: won ? "#4ade80" : "#f87171",
              fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)",
            }}>
              {won ? `Solved in ${guesses.length}!` : `Answer: ${answer}`}
            </div>
          </div>
        )}

        {/* Virtual keyboard */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center", padding: "0 4px" }}>
          {KEYBOARD_ROWS.map((row, rowIdx) => (
            <div key={rowIdx} style={{ display: "flex", gap: 3 }}>
              {row.map((key) => {
                const isWide = key === "ENTER" || key === "BACK";
                const keyState = keyStates[key];
                const colors = keyState ? TILE_COLORS[keyState] : { bg: "var(--ezy-surface-raised)", color: "var(--ezy-text)" };

                return (
                  <div
                    key={key}
                    onClick={() => handleKey(key === "BACK" ? "BACK" : key)}
                    style={{
                      width: isWide ? keyWidth * 1.5 : keyWidth,
                      height: keyHeight,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: colors.bg,
                      color: colors.color,
                      fontSize: isWide ? 9 : 11,
                      fontWeight: 600,
                      borderRadius: 4,
                      cursor: "pointer",
                      transition: "opacity 100ms ease",
                      fontFamily: "system-ui, sans-serif",
                      userSelect: "none",
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    {key === "BACK" ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M9 3H20L21 4V20L20 21H9L3 12L9 3Z" stroke="currentColor" strokeWidth="2" fill="none" />
                        <path d="M12 9L17 14M17 9L12 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    ) : key === "ENTER" ? (
                      "ENT"
                    ) : (
                      key
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Pause overlay */}
      {paused && (
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
  );
}

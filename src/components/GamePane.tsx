import { useState, useCallback } from "react";
import { useAppStore } from "../store";
import type { GameType } from "../types";
import SnakeGame from "./games/SnakeGame";
import Game2048 from "./games/Game2048";
import SudokuGame from "./games/SudokuGame";
import CrosswordGame from "./games/CrosswordGame";
import { CROSSWORD_PUZZLES } from "../lib/crossword-puzzles";
import { FaXmark, FaChevronLeft } from "react-icons/fa6";

interface GamePaneProps {
  onClose: () => void;
  initialGame?: GameType;
}

interface GameCardDef {
  type: GameType;
  name: string;
  description: string;
  icon: React.ReactNode;
  highscoreKey?: "snake" | "twentyFortyEight" | "sudoku";
}

const GAME_CARDS: GameCardDef[] = [
  {
    type: "snake",
    name: "Snake",
    description: "Classic snake game. Eat, grow, survive.",
    highscoreKey: "snake",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <path d="M4 14h4v4h4v-4h4v-4h4v4h4" stroke="var(--ezy-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="22" cy="14" r="2" fill="var(--ezy-accent)" />
      </svg>
    ),
  },
  {
    type: "2048",
    name: "2048",
    description: "Slide and merge tiles to reach 2048.",
    highscoreKey: "twentyFortyEight",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="2" y="2" width="11" height="11" rx="2" fill="var(--ezy-surface-raised)" stroke="var(--ezy-border)" strokeWidth="1" />
        <rect x="15" y="2" width="11" height="11" rx="2" fill="var(--ezy-surface-raised)" stroke="var(--ezy-border)" strokeWidth="1" />
        <rect x="2" y="15" width="11" height="11" rx="2" fill="var(--ezy-surface-raised)" stroke="var(--ezy-border)" strokeWidth="1" />
        <rect x="15" y="15" width="11" height="11" rx="2" fill="var(--ezy-accent)" opacity="0.6" />
        <text x="20.5" y="23" textAnchor="middle" fill="var(--ezy-text)" fontSize="7" fontWeight="700">2K</text>
      </svg>
    ),
  },
  {
    type: "sudoku",
    name: "Sudoku",
    description: "Fill the 9x9 grid. Three difficulty levels.",
    highscoreKey: "sudoku",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="2" y="2" width="24" height="24" rx="2" stroke="var(--ezy-border)" strokeWidth="1.5" fill="none" />
        <line x1="10" y1="2" x2="10" y2="26" stroke="var(--ezy-border)" strokeWidth="1" />
        <line x1="18" y1="2" x2="18" y2="26" stroke="var(--ezy-border)" strokeWidth="1" />
        <line x1="2" y1="10" x2="26" y2="10" stroke="var(--ezy-border)" strokeWidth="1" />
        <line x1="2" y1="18" x2="26" y2="18" stroke="var(--ezy-border)" strokeWidth="1" />
        <text x="6" y="8.5" textAnchor="middle" fill="var(--ezy-text-secondary)" fontSize="6">5</text>
        <text x="14" y="16.5" textAnchor="middle" fill="var(--ezy-accent)" fontSize="6">3</text>
        <text x="22" y="24" textAnchor="middle" fill="var(--ezy-text-secondary)" fontSize="6">7</text>
      </svg>
    ),
  },
  {
    type: "crossword",
    name: "Tech Crossword",
    description: "Dev-themed puzzles. 20 built-in + AI gen.",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="2" y="6" width="6" height="6" fill="var(--ezy-surface-raised)" stroke="var(--ezy-border)" strokeWidth="1" />
        <rect x="8" y="6" width="6" height="6" fill="var(--ezy-surface-raised)" stroke="var(--ezy-border)" strokeWidth="1" />
        <rect x="14" y="6" width="6" height="6" fill="var(--ezy-surface-raised)" stroke="var(--ezy-border)" strokeWidth="1" />
        <rect x="8" y="12" width="6" height="6" fill="var(--ezy-surface-raised)" stroke="var(--ezy-border)" strokeWidth="1" />
        <rect x="8" y="18" width="6" height="6" fill="var(--ezy-surface-raised)" stroke="var(--ezy-border)" strokeWidth="1" />
        <rect x="20" y="6" width="6" height="6" fill="var(--ezy-bg)" />
        <text x="5" y="11" textAnchor="middle" fill="var(--ezy-accent)" fontSize="5" fontWeight="600">A</text>
        <text x="11" y="11" textAnchor="middle" fill="var(--ezy-text)" fontSize="5" fontWeight="600">P</text>
        <text x="17" y="11" textAnchor="middle" fill="var(--ezy-text)" fontSize="5" fontWeight="600">I</text>
      </svg>
    ),
  },
];

const GAME_LABELS: Record<GameType, string> = {
  snake: "Snake",
  "2048": "2048",
  sudoku: "Sudoku",
  crossword: "Tech Crossword",
};

export default function GamePane({ onClose, initialGame }: GamePaneProps) {
  const [activeGame, setActiveGame] = useState<GameType | null>(initialGame ?? null);
  const highscores = useAppStore((s) => s.highscores);
  const completedCrosswordIds = useAppStore((s) => s.completedCrosswordIds);
  const customCrosswords = useAppStore((s) => s.customCrosswords);
  const addHighscore = useAppStore((s) => s.addHighscore);
  const markCrosswordCompleted = useAppStore((s) => s.markCrosswordCompleted);
  const addCustomCrossword = useAppStore((s) => s.addCustomCrossword);

  const handleBack = useCallback(() => setActiveGame(null), []);

  // Get all available crossword puzzles
  const allPuzzles = [...CROSSWORD_PUZZLES, ...customCrosswords];
  const uncompletedPuzzles = allPuzzles.filter((p) => !completedCrosswordIds.includes(p.id));

  const renderGame = () => {
    switch (activeGame) {
      case "snake":
        return <SnakeGame onAddHighscore={(score) => addHighscore("snake", score)} />;
      case "2048":
        return <Game2048 onAddHighscore={(score) => addHighscore("twentyFortyEight", score)} />;
      case "sudoku":
        return <SudokuGame onAddHighscore={(score) => addHighscore("sudoku", score)} />;
      case "crossword": {
        // Pick a random uncompleted puzzle, or first available
        const puzzle = uncompletedPuzzles.length > 0
          ? uncompletedPuzzles[Math.floor(Math.random() * uncompletedPuzzles.length)]
          : allPuzzles[0];
        if (!puzzle) return <div style={{ padding: 20, color: "var(--ezy-text-secondary)" }}>No puzzles available</div>;
        return (
          <CrosswordGame
            puzzle={puzzle}
            onComplete={(id) => markCrosswordCompleted(id)}
            allCompleted={uncompletedPuzzles.length <= 1}
            onGenerateNew={addCustomCrossword}
          />
        );
      }
      default:
        return null;
    }
  };

  const getTopScore = (key: "snake" | "twentyFortyEight" | "sudoku") => {
    const list = highscores[key];
    return list.length > 0 ? list[0].score : null;
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        backgroundColor: "var(--ezy-bg)",
        borderLeft: "1px solid var(--ezy-border)",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 36,
          minHeight: 36,
          padding: "0 8px",
          borderBottom: "1px solid var(--ezy-border)",
          backgroundColor: "var(--ezy-surface)",
          gap: 6,
        }}
      >
        {activeGame && (
          <div
            onClick={handleBack}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 24,
              height: 24,
              cursor: "pointer",
              borderRadius: 4,
              backgroundColor: "transparent",
              transition: "background-color 120ms ease",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)")}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
          >
            <FaChevronLeft size={11} color="var(--ezy-text-muted)" />
          </div>
        )}
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--ezy-text)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)",
          }}
        >
          {activeGame ? GAME_LABELS[activeGame] : "Mini Games"}
        </span>
        <div
          onClick={onClose}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            cursor: "pointer",
            borderRadius: 4,
            backgroundColor: "transparent",
            transition: "background-color 120ms ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)")}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
        >
          <FaXmark size={12} color="var(--ezy-text-muted)" />
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {activeGame ? (
          renderGame()
        ) : (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {GAME_CARDS.map((card) => {
              const topScore = card.highscoreKey ? getTopScore(card.highscoreKey) : null;
              const isCrossword = card.type === "crossword";
              const completedCount = isCrossword ? completedCrosswordIds.length : 0;
              const totalCount = isCrossword ? allPuzzles.length : 0;

              return (
                <div
                  key={card.type}
                  onClick={() => setActiveGame(card.type)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 12px",
                    borderRadius: 6,
                    backgroundColor: "var(--ezy-surface)",
                    border: "1px solid var(--ezy-border)",
                    cursor: "pointer",
                    transition: "background-color 120ms ease, border-color 120ms ease",
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
                  <div style={{ flexShrink: 0, width: 28, height: 28 }}>
                    {card.icon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)", lineHeight: 1.3 }}>
                      {card.name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ezy-text-secondary)", lineHeight: 1.4, marginTop: 2 }}>
                      {card.description}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0, textAlign: "right" }}>
                    {topScore !== null && (
                      <div style={{ fontSize: 11, color: "var(--ezy-accent)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                        {topScore.toLocaleString()}
                      </div>
                    )}
                    {isCrossword && (
                      <div style={{ fontSize: 10, color: "var(--ezy-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                        {completedCount}/{totalCount}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Highscores section */}
            {(highscores.snake.length > 0 || highscores.twentyFortyEight.length > 0 || highscores.sudoku.length > 0) && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ezy-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                  Top Scores
                </div>
                {(["snake", "twentyFortyEight", "sudoku"] as const).map((key) => {
                  const list = highscores[key];
                  if (list.length === 0) return null;
                  const label = key === "snake" ? "Snake" : key === "twentyFortyEight" ? "2048" : "Sudoku";
                  return (
                    <div key={key} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ezy-text-secondary)", marginBottom: 4 }}>{label}</div>
                      {list.slice(0, 5).map((entry, i) => (
                        <div
                          key={i}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            padding: "2px 8px",
                            fontSize: 11,
                            color: i === 0 ? "var(--ezy-accent)" : "var(--ezy-text-muted)",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          <span>{i + 1}.</span>
                          <span>{entry.score.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

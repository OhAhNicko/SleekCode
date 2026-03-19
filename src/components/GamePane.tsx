import { useState, useCallback, useEffect, useRef } from "react";
import { useAppStore } from "../store";
import type { GameType, CrosswordPuzzle } from "../types";
import SnakeGame from "./games/SnakeGame";
import Game2048 from "./games/Game2048";
import SudokuGame from "./games/SudokuGame";
import CrosswordGame from "./games/CrosswordGame";
import TicTacToeGame from "./games/TicTacToeGame";
import WordleGame from "./games/WordleGame";
import MinesweeperGame from "./games/MinesweeperGame";
import BlockBreakerGame from "./games/BlockBreakerGame";
import SolitaireGame from "./games/SolitaireGame";
import PongGame from "./games/PongGame";
import ChessGame from "./games/ChessGame";
import MemoryGame from "./games/MemoryGame";
import FlappyBirdGame from "./games/FlappyBirdGame";
import SpaceInvadersGame from "./games/SpaceInvadersGame";
import TetrisGame from "./games/TetrisGame";
import AsteroidsGame from "./games/AsteroidsGame";
import FroggerGame from "./games/FroggerGame";
import DuckHuntGame from "./games/DuckHuntGame";
import DonkeyKongGame from "./games/DonkeyKongGame";
import { CROSSWORD_PUZZLES } from "../lib/crossword-puzzles";
import { FaXmark, FaChevronLeft, FaPause, FaPlay } from "react-icons/fa6";

interface GamePaneProps {
  onClose: () => void;
  initialGame?: GameType;
  startPaused?: boolean;
}

interface GameCardDef {
  type: GameType;
  name: string;
  description: string;
  icon: React.ReactNode;
  statType?: "highscore" | "timedHighscore" | "crossword" | "wordle" | "ticTacToe" | "pong";
  statKey?: string;
}

const GAME_CARDS: GameCardDef[] = [
  {
    type: "snake",
    name: "Snake",
    description: "Classic snake game. Eat, grow, survive.",
    statType: "highscore",
    statKey: "snake",
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
    statType: "highscore",
    statKey: "twentyFortyEight",
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
    statType: "highscore",
    statKey: "sudoku",
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
    statType: "crossword",
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
  {
    type: "ticTacToe",
    name: "Tic-Tac-Toe",
    description: "Classic 3x3 or 5x5 vs AI.",
    statType: "ticTacToe",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <line x1="10" y1="4" x2="10" y2="24" stroke="var(--ezy-border)" strokeWidth="1.5" />
        <line x1="18" y1="4" x2="18" y2="24" stroke="var(--ezy-border)" strokeWidth="1.5" />
        <line x1="4" y1="10" x2="24" y2="10" stroke="var(--ezy-border)" strokeWidth="1.5" />
        <line x1="4" y1="18" x2="24" y2="18" stroke="var(--ezy-border)" strokeWidth="1.5" />
        <line x1="5.5" y1="5.5" x2="8.5" y2="8.5" stroke="var(--ezy-accent)" strokeWidth="1.8" strokeLinecap="round" />
        <line x1="8.5" y1="5.5" x2="5.5" y2="8.5" stroke="var(--ezy-accent)" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="14" cy="14" r="2.5" stroke="#f87171" strokeWidth="1.8" fill="none" />
        <line x1="19.5" y1="19.5" x2="22.5" y2="22.5" stroke="var(--ezy-accent)" strokeWidth="1.8" strokeLinecap="round" />
        <line x1="22.5" y1="19.5" x2="19.5" y2="22.5" stroke="var(--ezy-accent)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    type: "wordle",
    name: "Wordle",
    description: "Daily word puzzle. Tech + Classic modes.",
    statType: "wordle",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="2" y="4" width="5" height="5" rx="1" fill="#4ade80" />
        <rect x="8" y="4" width="5" height="5" rx="1" fill="var(--ezy-surface-raised)" />
        <rect x="14" y="4" width="5" height="5" rx="1" fill="var(--ezy-accent)" />
        <rect x="20" y="4" width="5" height="5" rx="1" fill="var(--ezy-surface-raised)" />
        <rect x="2" y="11" width="5" height="5" rx="1" fill="var(--ezy-surface-raised)" />
        <rect x="8" y="11" width="5" height="5" rx="1" fill="#4ade80" />
        <rect x="14" y="11" width="5" height="5" rx="1" fill="#4ade80" />
        <rect x="20" y="11" width="5" height="5" rx="1" fill="var(--ezy-accent)" />
        <rect x="2" y="18" width="5" height="5" rx="1" fill="#4ade80" />
        <rect x="8" y="18" width="5" height="5" rx="1" fill="#4ade80" />
        <rect x="14" y="18" width="5" height="5" rx="1" fill="#4ade80" />
        <rect x="20" y="18" width="5" height="5" rx="1" fill="#4ade80" />
      </svg>
    ),
  },
  {
    type: "minesweeper",
    name: "Minesweeper",
    description: "Clear the field. Don't hit a mine.",
    statType: "timedHighscore",
    statKey: "minesweeperEasy",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <circle cx="14" cy="14" r="5" fill="var(--ezy-text-muted)" />
        <line x1="14" y1="5" x2="14" y2="9" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="14" y1="19" x2="14" y2="23" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="5" y1="14" x2="9" y2="14" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="19" y1="14" x2="23" y2="14" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="8" y1="8" x2="10.5" y2="10.5" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="17.5" y1="17.5" x2="20" y2="20" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="20" y1="8" x2="17.5" y2="10.5" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="10.5" y1="17.5" x2="8" y2="20" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="14" cy="14" r="2" fill="var(--ezy-surface)" />
      </svg>
    ),
  },
  {
    type: "blockBreaker",
    name: "Block Breaker",
    description: "Break blocks with a bouncing ball.",
    statType: "highscore",
    statKey: "blockBreaker",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="2" y="3" width="7" height="3" rx="1" fill="var(--ezy-accent)" opacity="0.8" />
        <rect x="10" y="3" width="7" height="3" rx="1" fill="var(--ezy-accent)" opacity="0.6" />
        <rect x="19" y="3" width="7" height="3" rx="1" fill="var(--ezy-accent)" opacity="0.8" />
        <rect x="2" y="7" width="7" height="3" rx="1" fill="var(--ezy-surface-raised)" />
        <rect x="10" y="7" width="7" height="3" rx="1" fill="var(--ezy-surface-raised)" />
        <rect x="19" y="7" width="7" height="3" rx="1" fill="var(--ezy-surface-raised)" />
        <circle cx="14" cy="18" r="2.5" fill="var(--ezy-accent)" />
        <rect x="8" y="23" width="12" height="3" rx="1.5" fill="var(--ezy-surface-raised)" stroke="var(--ezy-accent)" strokeWidth="0.5" />
      </svg>
    ),
  },
  {
    type: "solitaire",
    name: "Solitaire",
    description: "Klondike, Spider, FreeCell, Pyramid.",
    statType: "timedHighscore",
    statKey: "solitaireKlondike",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="3" y="4" width="10" height="14" rx="2" fill="var(--ezy-surface-raised)" stroke="var(--ezy-border)" strokeWidth="1" />
        <rect x="8" y="7" width="10" height="14" rx="2" fill="var(--ezy-surface)" stroke="var(--ezy-border)" strokeWidth="1" />
        <rect x="13" y="10" width="10" height="14" rx="2" fill="var(--ezy-surface-raised)" stroke="var(--ezy-accent)" strokeWidth="1" />
        <text x="18" y="19" textAnchor="middle" fill="#f87171" fontSize="8" fontWeight="700">A</text>
      </svg>
    ),
  },
  {
    type: "pong",
    name: "Pong",
    description: "Classic paddle game vs AI.",
    statType: "pong",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="4" y="8" width="3" height="12" rx="1.5" fill="var(--ezy-accent)" />
        <rect x="21" y="8" width="3" height="12" rx="1.5" fill="#f87171" />
        <line x1="14" y1="4" x2="14" y2="24" stroke="var(--ezy-border)" strokeWidth="1" strokeDasharray="2 2" />
        <circle cx="14" cy="14" r="2" fill="var(--ezy-accent)" />
      </svg>
    ),
  },
  {
    type: "chess",
    name: "Chess",
    description: "Classic chess vs AI. Three difficulty levels.",
    statType: "chess" as GameCardDef["statType"],
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="4" y="4" width="10" height="10" fill="var(--ezy-surface-raised)" />
        <rect x="14" y="4" width="10" height="10" fill="var(--ezy-surface)" stroke="var(--ezy-border)" strokeWidth="0.5" />
        <rect x="4" y="14" width="10" height="10" fill="var(--ezy-surface)" stroke="var(--ezy-border)" strokeWidth="0.5" />
        <rect x="14" y="14" width="10" height="10" fill="var(--ezy-surface-raised)" />
        <text x="14" y="18" textAnchor="middle" fill="var(--ezy-accent)" fontSize="14" fontFamily="serif">{"\u2658"}</text>
      </svg>
    ),
  },
  {
    type: "memory",
    name: "Memory",
    description: "Flip cards and find matching pairs.",
    statType: "timedHighscore",
    statKey: "memoryEasy",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="3" y="4" width="9" height="9" rx="2" fill="var(--ezy-accent)" />
        <rect x="16" y="4" width="9" height="9" rx="2" fill="var(--ezy-surface-raised)" stroke="var(--ezy-border)" strokeWidth="1" />
        <rect x="3" y="16" width="9" height="9" rx="2" fill="var(--ezy-surface-raised)" stroke="var(--ezy-border)" strokeWidth="1" />
        <rect x="16" y="16" width="9" height="9" rx="2" fill="var(--ezy-accent)" />
        <text x="7.5" y="11" textAnchor="middle" fontSize="7" fontWeight="700" fill="var(--ezy-bg)">?</text>
        <text x="20.5" y="23" textAnchor="middle" fontSize="7" fontWeight="700" fill="var(--ezy-bg)">?</text>
      </svg>
    ),
  },
  {
    type: "flappyBird",
    name: "Flappy Bird",
    description: "Tap to flap. Dodge pipes. How far can you go?",
    statType: "highscore",
    statKey: "flappyBird",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <ellipse cx="12" cy="14" rx="6" ry="5" fill="var(--ezy-accent)" />
        <ellipse cx="10" cy="13" rx="3.5" ry="2" fill="var(--ezy-surface-raised)" stroke="var(--ezy-border)" strokeWidth="0.5" />
        <circle cx="15" cy="12.5" r="1.5" fill="var(--ezy-bg)" />
        <circle cx="15.5" cy="12.5" r="0.7" fill="var(--ezy-text)" />
        <polygon points="18,14 22,14.5 18,16" fill="var(--ezy-surface-raised)" />
        <rect x="23" y="2" width="4" height="8" rx="1" fill="var(--ezy-surface-raised)" stroke="var(--ezy-border)" strokeWidth="0.5" />
        <rect x="23" y="20" width="4" height="8" rx="1" fill="var(--ezy-surface-raised)" stroke="var(--ezy-border)" strokeWidth="0.5" />
      </svg>
    ),
  },
  {
    type: "spaceInvaders",
    name: "Space Invaders",
    description: "Defend Earth. Shoot aliens before they land.",
    statType: "highscore",
    statKey: "spaceInvaders",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="8" y="6" width="4" height="4" fill="var(--ezy-accent)" />
        <rect x="16" y="6" width="4" height="4" fill="var(--ezy-accent)" />
        <rect x="6" y="10" width="16" height="4" fill="var(--ezy-accent)" />
        <rect x="4" y="14" width="20" height="4" fill="var(--ezy-accent)" />
        <rect x="4" y="18" width="4" height="4" fill="var(--ezy-accent)" />
        <rect x="10" y="18" width="8" height="4" fill="var(--ezy-accent)" />
        <rect x="20" y="18" width="4" height="4" fill="var(--ezy-accent)" />
      </svg>
    ),
  },
  {
    type: "tetris",
    name: "Tetris",
    description: "Stack blocks. Clear lines. Chase the Tetris.",
    statType: "highscore",
    statKey: "tetris",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="4" y="18" width="6" height="6" rx="1" fill="#06b6d4" />
        <rect x="10" y="18" width="6" height="6" rx="1" fill="#06b6d4" />
        <rect x="10" y="12" width="6" height="6" rx="1" fill="#a855f7" />
        <rect x="16" y="12" width="6" height="6" rx="1" fill="#a855f7" />
        <rect x="16" y="18" width="6" height="6" rx="1" fill="#a855f7" />
        <rect x="10" y="6" width="6" height="6" rx="1" fill="#f97316" />
        <rect x="16" y="6" width="6" height="6" rx="1" fill="#f97316" />
        <rect x="22" y="6" width="4" height="6" rx="1" fill="#f97316" />
      </svg>
    ),
  },
  {
    type: "asteroids",
    name: "Asteroids",
    description: "Blast rocks in deep space. Vector arcade classic.",
    statType: "highscore",
    statKey: "asteroids",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <polygon points="14,2 18,8 24,10 20,16 22,24 14,20 6,24 8,16 4,10 10,8" stroke="var(--ezy-text-muted)" strokeWidth="1.5" fill="none" />
        <polygon points="14,22 13,26 15,26" fill="var(--ezy-accent)" />
        <line x1="14" y1="18" x2="14" y2="22" stroke="var(--ezy-accent)" strokeWidth="1" />
      </svg>
    ),
  },
  {
    type: "frogger",
    name: "Frogger",
    description: "Cross roads and rivers. Reach the lily pads.",
    statType: "highscore",
    statKey: "frogger",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <ellipse cx="14" cy="16" rx="8" ry="6" fill="#22c55e" />
        <circle cx="10" cy="11" r="3" fill="#22c55e" />
        <circle cx="18" cy="11" r="3" fill="#22c55e" />
        <circle cx="10" cy="10.5" r="1.5" fill="var(--ezy-bg)" />
        <circle cx="18" cy="10.5" r="1.5" fill="var(--ezy-bg)" />
        <circle cx="10.5" cy="10.5" r="0.7" fill="var(--ezy-text)" />
        <circle cx="18.5" cy="10.5" r="0.7" fill="var(--ezy-text)" />
      </svg>
    ),
  },
  {
    type: "duckHunt",
    name: "Duck Hunt",
    description: "Aim. Shoot. Don't let the ducks escape.",
    statType: "highscore",
    statKey: "duckHunt",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <ellipse cx="12" cy="16" rx="6" ry="5" fill="#22c55e" />
        <ellipse cx="14" cy="12" rx="4" ry="3.5" fill="#22c55e" />
        <circle cx="16" cy="11" r="1.2" fill="var(--ezy-bg)" />
        <circle cx="16.3" cy="11" r="0.5" fill="var(--ezy-text)" />
        <polygon points="18,12.5 22,12 18,13.5" fill="var(--ezy-surface-raised)" />
        <line x1="8" y1="20" x2="6" y2="24" stroke="var(--ezy-accent)" strokeWidth="1.5" />
        <line x1="12" y1="20" x2="12" y2="24" stroke="var(--ezy-accent)" strokeWidth="1.5" />
        <line x1="22" y1="4" x2="22" y2="10" stroke="var(--ezy-text-muted)" strokeWidth="0.8" />
        <line x1="19" y1="7" x2="25" y2="7" stroke="var(--ezy-text-muted)" strokeWidth="0.8" />
      </svg>
    ),
  },
  {
    type: "donkeyKong",
    name: "Donkey Kong",
    description: "Climb girders. Jump barrels. Rescue Pauline.",
    statType: "highscore",
    statKey: "donkeyKong",
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="2" y="22" width="24" height="3" rx="1" fill="#dc2626" />
        <rect x="4" y="15" width="20" height="3" rx="1" fill="#dc2626" />
        <rect x="2" y="8" width="18" height="3" rx="1" fill="#dc2626" />
        <rect x="6" y="11" width="2" height="4" fill="var(--ezy-text-muted)" />
        <rect x="20" y="18" width="2" height="4" fill="var(--ezy-text-muted)" />
        <circle cx="8" cy="5" r="4" fill="#92400e" />
        <rect x="18" y="19" width="4" height="3" fill="#dc2626" />
        <rect x="19" y="17" width="2" height="2" fill="var(--ezy-surface-raised)" />
      </svg>
    ),
  },
];

const GAME_LABELS: Record<GameType, string> = {
  snake: "Snake",
  "2048": "2048",
  sudoku: "Sudoku",
  crossword: "Tech Crossword",
  ticTacToe: "Tic-Tac-Toe",
  wordle: "Wordle",
  minesweeper: "Minesweeper",
  blockBreaker: "Block Breaker",
  solitaire: "Solitaire",
  pong: "Pong",
  chess: "Chess",
  memory: "Memory",
  flappyBird: "Flappy Bird",
  spaceInvaders: "Space Invaders",
  tetris: "Tetris",
  asteroids: "Asteroids",
  frogger: "Frogger",
  duckHunt: "Duck Hunt",
  donkeyKong: "Donkey Kong",
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function GamePane({ onClose, initialGame, startPaused }: GamePaneProps) {
  const [activeGame, setActiveGame] = useState<GameType | null>(initialGame ?? null);
  const [paused, setPaused] = useState(startPaused ?? false);
  const gamePaneRef = useRef<HTMLDivElement>(null);
  const highscores = useAppStore((s) => s.highscores);
  const timedHighscores = useAppStore((s) => s.timedHighscores);
  const gameStats = useAppStore((s) => s.gameStats);
  const completedCrosswordIds = useAppStore((s) => s.completedCrosswordIds);
  const customCrosswords = useAppStore((s) => s.customCrosswords);
  const addHighscore = useAppStore((s) => s.addHighscore);
  const addTimedHighscore = useAppStore((s) => s.addTimedHighscore);
  const updateWordleStats = useAppStore((s) => s.updateWordleStats);
  const updateTicTacToeStats = useAppStore((s) => s.updateTicTacToeStats);
  const updatePongStats = useAppStore((s) => s.updatePongStats);
  const updateChessStats = useAppStore((s) => s.updateChessStats);
  const markCrosswordCompleted = useAppStore((s) => s.markCrosswordCompleted);
  const addCustomCrossword = useAppStore((s) => s.addCustomCrossword);

  const handleBack = useCallback(() => { setActiveGame(null); setPaused(false); }, []);

  // Space key toggles pause when a game is active AND the game pane is focused.
  // Uses the container ref instead of window to avoid stealing Space from CLI panes.
  useEffect(() => {
    if (!activeGame) return;
    const container = gamePaneRef.current;
    if (!container) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.code === "Space" || e.key === "Escape") && !e.repeat) {
        e.preventDefault();
        setPaused((p) => !p);
      }
    };
    container.addEventListener("keydown", handler);
    return () => container.removeEventListener("keydown", handler);
  }, [activeGame]);

  // Broadcast active game to PaneGrid for pause/resume tracking
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("ezydev:game-active", { detail: { game: activeGame } }));
  }, [activeGame]);

  // Get all available crossword puzzles
  const allPuzzles = [...CROSSWORD_PUZZLES, ...customCrosswords];
  const uncompletedPuzzles = allPuzzles.filter((p) => !completedCrosswordIds.includes(p.id));

  // Stable crossword puzzle selection — pick once, not every render
  const crosswordRef = useRef<CrosswordPuzzle | null>(null);
  if (activeGame === "crossword" && !crosswordRef.current) {
    crosswordRef.current = uncompletedPuzzles.length > 0
      ? uncompletedPuzzles[Math.floor(Math.random() * uncompletedPuzzles.length)]
      : allPuzzles[0] ?? null;
  }
  if (activeGame !== "crossword") crosswordRef.current = null;

  const renderGame = () => {
    switch (activeGame) {
      case "snake":
        return <SnakeGame onAddHighscore={(score) => addHighscore("snake", score)} paused={paused} />;
      case "2048":
        return <Game2048 onAddHighscore={(score) => addHighscore("twentyFortyEight", score)} paused={paused} />;
      case "sudoku":
        return <SudokuGame onAddHighscore={(score) => addHighscore("sudoku", score)} paused={paused} />;
      case "crossword": {
        const puzzle = crosswordRef.current;
        if (!puzzle) return <div style={{ padding: 20, color: "var(--ezy-text-secondary)" }}>No puzzles available</div>;
        return (
          <CrosswordGame
            puzzle={puzzle}
            onComplete={(id) => { markCrosswordCompleted(id); crosswordRef.current = null; }}
            allCompleted={uncompletedPuzzles.length <= 1}
            onGenerateNew={addCustomCrossword}
            paused={paused}
          />
        );
      }
      case "ticTacToe":
        return <TicTacToeGame onUpdateStats={updateTicTacToeStats} paused={paused} />;
      case "wordle":
        return <WordleGame onUpdateStats={updateWordleStats} paused={paused} />;
      case "minesweeper":
        return <MinesweeperGame onAddTimedHighscore={addTimedHighscore} paused={paused} />;
      case "blockBreaker":
        return <BlockBreakerGame onAddHighscore={(score) => addHighscore("blockBreaker", score)} paused={paused} />;
      case "solitaire":
        return (
          <SolitaireGame
            onAddTimedHighscore={addTimedHighscore}
            onAddHighscore={(score) => addHighscore("solitairePyramid", score)}
            paused={paused}
          />
        );
      case "pong":
        return <PongGame onUpdateStats={updatePongStats} paused={paused} />;
      case "chess":
        return <ChessGame onUpdateStats={updateChessStats} paused={paused} />;
      case "memory":
        return <MemoryGame onAddTimedHighscore={addTimedHighscore} paused={paused} />;
      case "flappyBird":
        return <FlappyBirdGame onAddHighscore={(s) => addHighscore("flappyBird", s)} paused={paused} />;
      case "spaceInvaders":
        return <SpaceInvadersGame onAddHighscore={(s) => addHighscore("spaceInvaders", s)} paused={paused} />;
      case "tetris":
        return <TetrisGame onAddHighscore={(s) => addHighscore("tetris", s)} paused={paused} />;
      case "asteroids":
        return <AsteroidsGame onAddHighscore={(s) => addHighscore("asteroids", s)} paused={paused} />;
      case "frogger":
        return <FroggerGame onAddHighscore={(s) => addHighscore("frogger", s)} paused={paused} />;
      case "duckHunt":
        return <DuckHuntGame onAddHighscore={(s) => addHighscore("duckHunt", s)} paused={paused} />;
      case "donkeyKong":
        return <DonkeyKongGame onAddHighscore={(s) => addHighscore("donkeyKong", s)} paused={paused} />;
      default:
        return null;
    }
  };

  const getCardStat = (card: GameCardDef): React.ReactNode => {
    switch (card.statType) {
      case "highscore": {
        const key = card.statKey as keyof typeof highscores;
        const list = highscores[key];
        if (!list || list.length === 0) return null;
        return (
          <div style={{ fontSize: 11, color: "var(--ezy-accent)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
            {list[0].score.toLocaleString()}
          </div>
        );
      }
      case "timedHighscore": {
        const key = card.statKey as keyof typeof timedHighscores;
        const list = timedHighscores[key];
        if (!list || list.length === 0) return null;
        return (
          <div style={{ fontSize: 11, color: "var(--ezy-accent)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
            {formatTime(list[0].seconds)}
          </div>
        );
      }
      case "crossword": {
        return (
          <div style={{ fontSize: 10, color: "var(--ezy-text-muted)", fontVariantNumeric: "tabular-nums" }}>
            {completedCrosswordIds.length}/{allPuzzles.length}
          </div>
        );
      }
      case "wordle": {
        const best = gameStats.wordle.tech.won > gameStats.wordle.classic.won ? gameStats.wordle.tech : gameStats.wordle.classic;
        if (best.played === 0) return null;
        return (
          <div style={{ fontSize: 10, color: "var(--ezy-accent)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
            W:{best.won} Str:{best.currentStreak}
          </div>
        );
      }
      case "ticTacToe": {
        const s3 = gameStats.ticTacToe["3x3"];
        const s5 = gameStats.ticTacToe["5x5"];
        const total = s3.wins + s3.losses + s3.draws + s5.wins + s5.losses + s5.draws;
        if (total === 0) return null;
        const w = s3.wins + s5.wins;
        const l = s3.losses + s5.losses;
        const d = s3.draws + s5.draws;
        return (
          <div style={{ fontSize: 10, color: "var(--ezy-accent)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
            {w}W {l}L {d}D
          </div>
        );
      }
      case "pong": {
        const ps = gameStats.pong ?? { wins: 0, losses: 0 };
        if (ps.wins + ps.losses === 0) return null;
        return (
          <div style={{ fontSize: 10, color: "var(--ezy-accent)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
            {ps.wins}W {ps.losses}L
          </div>
        );
      }
      case "chess" as string: {
        const cs = gameStats.chess;
        if (!cs) return null;
        const tw = cs.easy.wins + cs.medium.wins + cs.hard.wins;
        const tl = cs.easy.losses + cs.medium.losses + cs.hard.losses;
        const td = cs.easy.draws + cs.medium.draws + cs.hard.draws;
        if (tw + tl + td === 0) return null;
        return (
          <div style={{ fontSize: 10, color: "var(--ezy-accent)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
            {tw}W {tl}L {td}D
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div
      ref={gamePaneRef}
      tabIndex={-1}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        backgroundColor: "var(--ezy-bg)",
        borderLeft: "1px solid var(--ezy-border)",
        overflow: "hidden",
        outline: "none",
      }}
      onMouseDown={() => gamePaneRef.current?.focus()}
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
        {activeGame && (
          <div
            onClick={() => setPaused((p) => !p)}
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
            title={paused ? "Resume" : "Pause"}
          >
            {paused ? <FaPlay size={10} color="var(--ezy-accent)" /> : <FaPause size={10} color="var(--ezy-text-muted)" />}
          </div>
        )}
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
            {GAME_CARDS.map((card) => (
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
                  transform: "translateY(0) scale(1)",
                  boxShadow: "0 0 0 0 transparent",
                  transition: "transform 150ms cubic-bezier(0.2, 0, 0, 1), box-shadow 150ms cubic-bezier(0.2, 0, 0, 1), background-color 150ms ease, border-color 150ms ease",
                }}
                onMouseEnter={(e) => {
                  const el = e.currentTarget;
                  el.style.backgroundColor = "var(--ezy-surface-raised)";
                  el.style.borderColor = "var(--ezy-accent)";
                  el.style.transform = "translateY(-2px) scale(1.015)";
                  el.style.boxShadow = "0 4px 16px rgba(0,0,0,0.35), 0 0 0 1px var(--ezy-accent)";
                }}
                onMouseLeave={(e) => {
                  const el = e.currentTarget;
                  el.style.backgroundColor = "var(--ezy-surface)";
                  el.style.borderColor = "var(--ezy-border)";
                  el.style.transform = "translateY(0) scale(1)";
                  el.style.boxShadow = "0 0 0 0 transparent";
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
                  {getCardStat(card)}
                </div>
              </div>
            ))}

            {/* Highscores section */}
            {(highscores.snake.length > 0 || highscores.twentyFortyEight.length > 0 || highscores.sudoku.length > 0 || highscores.blockBreaker.length > 0 || highscores.flappyBird.length > 0 || highscores.spaceInvaders.length > 0 || highscores.tetris.length > 0 || highscores.asteroids.length > 0 || highscores.frogger.length > 0 || highscores.duckHunt.length > 0 || highscores.donkeyKong.length > 0) && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ezy-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                  Top Scores
                </div>
                {(["snake", "twentyFortyEight", "sudoku", "blockBreaker", "flappyBird", "spaceInvaders", "tetris", "asteroids", "frogger", "duckHunt", "donkeyKong"] as const).map((key) => {
                  const list = highscores[key];
                  if (list.length === 0) return null;
                  const labelMap: Record<string, string> = { snake: "Snake", twentyFortyEight: "2048", sudoku: "Sudoku", blockBreaker: "Block Breaker", flappyBird: "Flappy Bird", spaceInvaders: "Space Invaders", tetris: "Tetris", asteroids: "Asteroids", frogger: "Frogger", duckHunt: "Duck Hunt", donkeyKong: "Donkey Kong" };
                  const label = labelMap[key] ?? key;
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

            {/* Best Times section */}
            {(timedHighscores.minesweeperEasy.length > 0 || timedHighscores.minesweeperMedium.length > 0 || timedHighscores.minesweeperHard.length > 0 ||
              timedHighscores.solitaireKlondike.length > 0 || timedHighscores.solitaireSpider.length > 0 || timedHighscores.solitaireFreecell.length > 0 ||
              timedHighscores.memoryEasy.length > 0 || timedHighscores.memoryMedium.length > 0 || timedHighscores.memoryHard.length > 0) && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ezy-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                  Best Times
                </div>
                {(["minesweeperEasy", "minesweeperMedium", "minesweeperHard", "solitaireKlondike", "solitaireSpider", "solitaireFreecell", "memoryEasy", "memoryMedium", "memoryHard"] as const).map((key) => {
                  const list = timedHighscores[key];
                  if (list.length === 0) return null;
                  const labels: Record<string, string> = {
                    minesweeperEasy: "Minesweeper Easy",
                    minesweeperMedium: "Minesweeper Medium",
                    minesweeperHard: "Minesweeper Hard",
                    solitaireKlondike: "Klondike",
                    solitaireSpider: "Spider",
                    solitaireFreecell: "FreeCell",
                    memoryEasy: "Memory Easy",
                    memoryMedium: "Memory Medium",
                    memoryHard: "Memory Hard",
                  };
                  return (
                    <div key={key} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ezy-text-secondary)", marginBottom: 4 }}>{labels[key]}</div>
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
                          <span>{formatTime(entry.seconds)}</span>
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

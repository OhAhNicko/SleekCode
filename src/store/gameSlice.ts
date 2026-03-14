import type { StateCreator } from "zustand";
import type { CrosswordPuzzle } from "../types";

export interface HighscoreEntry {
  score: number;
  date: number;
}

export interface TimedHighscoreEntry {
  seconds: number;
  date: number;
}

type HighscoreGame = "snake" | "twentyFortyEight" | "sudoku" | "blockBreaker" | "solitairePyramid";
type TimedHighscoreGame = "minesweeperEasy" | "minesweeperMedium" | "minesweeperHard" | "solitaireKlondike" | "solitaireSpider" | "solitaireFreecell" | "memoryEasy" | "memoryMedium" | "memoryHard";

export interface WordleStats {
  played: number;
  won: number;
  currentStreak: number;
  maxStreak: number;
}

export interface TicTacToeStats {
  wins: number;
  losses: number;
  draws: number;
}

export interface PongStats {
  wins: number;
  losses: number;
}

export interface ChessStats {
  wins: number;
  losses: number;
  draws: number;
}

export interface GameStats {
  wordle: {
    tech: WordleStats;
    classic: WordleStats;
  };
  ticTacToe: {
    "3x3": TicTacToeStats;
    "5x5": TicTacToeStats;
  };
  pong: PongStats;
  chess: {
    easy: ChessStats;
    medium: ChessStats;
    hard: ChessStats;
  };
}

const emptyWordleStats = (): WordleStats => ({ played: 0, won: 0, currentStreak: 0, maxStreak: 0 });
const emptyTicTacToeStats = (): TicTacToeStats => ({ wins: 0, losses: 0, draws: 0 });
const emptyChessStats = (): ChessStats => ({ wins: 0, losses: 0, draws: 0 });

export interface GameSlice {
  highscores: {
    snake: HighscoreEntry[];
    twentyFortyEight: HighscoreEntry[];
    sudoku: HighscoreEntry[];
    blockBreaker: HighscoreEntry[];
    solitairePyramid: HighscoreEntry[];
  };
  timedHighscores: {
    minesweeperEasy: TimedHighscoreEntry[];
    minesweeperMedium: TimedHighscoreEntry[];
    minesweeperHard: TimedHighscoreEntry[];
    solitaireKlondike: TimedHighscoreEntry[];
    solitaireSpider: TimedHighscoreEntry[];
    solitaireFreecell: TimedHighscoreEntry[];
    memoryEasy: TimedHighscoreEntry[];
    memoryMedium: TimedHighscoreEntry[];
    memoryHard: TimedHighscoreEntry[];
  };
  gameStats: GameStats;
  completedCrosswordIds: string[];
  customCrosswords: CrosswordPuzzle[];
  addHighscore: (game: HighscoreGame, score: number) => void;
  addTimedHighscore: (game: TimedHighscoreGame, seconds: number) => void;
  updateWordleStats: (mode: "tech" | "classic", won: boolean) => void;
  updateTicTacToeStats: (variant: "3x3" | "5x5", result: "win" | "loss" | "draw") => void;
  updatePongStats: (result: "win" | "loss") => void;
  updateChessStats: (difficulty: "easy" | "medium" | "hard", result: "win" | "loss" | "draw") => void;
  markCrosswordCompleted: (id: string) => void;
  addCustomCrossword: (puzzle: CrosswordPuzzle) => void;
}

export const createGameSlice: StateCreator<GameSlice, [], [], GameSlice> = (set) => ({
  highscores: {
    snake: [],
    twentyFortyEight: [],
    sudoku: [],
    blockBreaker: [],
    solitairePyramid: [],
  },
  timedHighscores: {
    minesweeperEasy: [],
    minesweeperMedium: [],
    minesweeperHard: [],
    solitaireKlondike: [],
    solitaireSpider: [],
    solitaireFreecell: [],
    memoryEasy: [],
    memoryMedium: [],
    memoryHard: [],
  },
  gameStats: {
    wordle: {
      tech: emptyWordleStats(),
      classic: emptyWordleStats(),
    },
    ticTacToe: {
      "3x3": emptyTicTacToeStats(),
      "5x5": emptyTicTacToeStats(),
    },
    pong: { wins: 0, losses: 0 },
    chess: {
      easy: emptyChessStats(),
      medium: emptyChessStats(),
      hard: emptyChessStats(),
    },
  },
  completedCrosswordIds: [],
  customCrosswords: [],

  addHighscore: (game, score) =>
    set((state) => {
      const list = [...state.highscores[game], { score, date: Date.now() }];
      list.sort((a, b) => b.score - a.score);
      return {
        highscores: {
          ...state.highscores,
          [game]: list.slice(0, 10),
        },
      };
    }),

  addTimedHighscore: (game, seconds) =>
    set((state) => {
      const list = [...state.timedHighscores[game], { seconds, date: Date.now() }];
      list.sort((a, b) => a.seconds - b.seconds); // Lower time = better
      return {
        timedHighscores: {
          ...state.timedHighscores,
          [game]: list.slice(0, 10),
        },
      };
    }),

  updateWordleStats: (mode, won) =>
    set((state) => {
      const prev = state.gameStats.wordle[mode];
      const newStreak = won ? prev.currentStreak + 1 : 0;
      return {
        gameStats: {
          ...state.gameStats,
          wordle: {
            ...state.gameStats.wordle,
            [mode]: {
              played: prev.played + 1,
              won: prev.won + (won ? 1 : 0),
              currentStreak: newStreak,
              maxStreak: Math.max(prev.maxStreak, newStreak),
            },
          },
        },
      };
    }),

  updateTicTacToeStats: (variant, result) =>
    set((state) => {
      const prev = state.gameStats.ticTacToe[variant];
      return {
        gameStats: {
          ...state.gameStats,
          ticTacToe: {
            ...state.gameStats.ticTacToe,
            [variant]: {
              wins: prev.wins + (result === "win" ? 1 : 0),
              losses: prev.losses + (result === "loss" ? 1 : 0),
              draws: prev.draws + (result === "draw" ? 1 : 0),
            },
          },
        },
      };
    }),

  updatePongStats: (result) =>
    set((state) => ({
      gameStats: {
        ...state.gameStats,
        pong: {
          wins: state.gameStats.pong.wins + (result === "win" ? 1 : 0),
          losses: state.gameStats.pong.losses + (result === "loss" ? 1 : 0),
        },
      },
    })),

  updateChessStats: (difficulty, result) =>
    set((state) => {
      const prev = state.gameStats.chess[difficulty];
      return {
        gameStats: {
          ...state.gameStats,
          chess: {
            ...state.gameStats.chess,
            [difficulty]: {
              wins: prev.wins + (result === "win" ? 1 : 0),
              losses: prev.losses + (result === "loss" ? 1 : 0),
              draws: prev.draws + (result === "draw" ? 1 : 0),
            },
          },
        },
      };
    }),

  markCrosswordCompleted: (id) =>
    set((state) => ({
      completedCrosswordIds: state.completedCrosswordIds.includes(id)
        ? state.completedCrosswordIds
        : [...state.completedCrosswordIds, id],
    })),

  addCustomCrossword: (puzzle) =>
    set((state) => ({
      customCrosswords: [...state.customCrosswords, puzzle],
    })),
});

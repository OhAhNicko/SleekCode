import type { StateCreator } from "zustand";
import type { CrosswordPuzzle, GameType } from "../types";

export const GAME_SIDEBAR_MIN_WIDTH = 320;
export const GAME_SIDEBAR_MAX_WIDTH = 900;
export const GAME_SIDEBAR_DEFAULT_WIDTH = 420;

const clampGameSidebarWidth = (w: number) =>
  Math.max(GAME_SIDEBAR_MIN_WIDTH, Math.min(GAME_SIDEBAR_MAX_WIDTH, Math.round(w)));

export interface HighscoreEntry {
  score: number;
  date: number;
}

export interface TimedHighscoreEntry {
  seconds: number;
  date: number;
}

type HighscoreGame = "snake" | "twentyFortyEight" | "sudoku" | "blockBreaker" | "solitairePyramid" | "flappyBird" | "spaceInvaders" | "tetris" | "asteroids" | "frogger" | "duckHunt" | "donkeyKong";
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
    flappyBird: HighscoreEntry[];
    spaceInvaders: HighscoreEntry[];
    tetris: HighscoreEntry[];
    asteroids: HighscoreEntry[];
    frogger: HighscoreEntry[];
    duckHunt: HighscoreEntry[];
    donkeyKong: HighscoreEntry[];
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

  /* ---- Games sidebar -------------------------------------------------
   * The games panel is ONE app-level sidebar (rendered once in App.tsx),
   * not a pane in any tab's layout. That is deliberate: it used to be a
   * layout pane, and because every open project tab keeps its PaneGrid
   * mounted, the unguarded made:open-game listener added a copy to EVERY
   * tab while the X removed only one — so closing it "once" left copies
   * behind everywhere. A single instance backed by a single boolean makes
   * open and close global by construction rather than by broadcast.
   * See docs/architecture.md ("Games sidebar"). */
  gameSidebarOpen: boolean;
  gameSidebarWidth: number;
  /** Last game selected, so reopening resumes it instead of the picker. */
  gameSidebarGame?: GameType;
  /** Armed by the AI-done auto-close so the next open starts paused.
   *  Transient — not persisted. */
  gameSidebarPaused: boolean;
  toggleGameSidebar: () => void;
  /** `paused` arms a paused restart; a plain close disarms it. */
  closeGameSidebar: (opts?: { paused?: boolean }) => void;
  setGameSidebarWidth: (width: number) => void;
  setGameSidebarGame: (game?: GameType) => void;
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
    flappyBird: [],
    spaceInvaders: [],
    tetris: [],
    asteroids: [],
    frogger: [],
    duckHunt: [],
    donkeyKong: [],
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

  gameSidebarOpen: false,
  gameSidebarWidth: GAME_SIDEBAR_DEFAULT_WIDTH,
  gameSidebarGame: undefined,
  gameSidebarPaused: false,

  toggleGameSidebar: () =>
    set((state) => ({
      gameSidebarOpen: !state.gameSidebarOpen,
      // Closing by hand disarms the paused restart; opening preserves it so an
      // AI-done auto-close still reopens paused, matching the old pane's
      // shouldStartPaused handoff.
      gameSidebarPaused: state.gameSidebarOpen ? false : state.gameSidebarPaused,
    })),

  closeGameSidebar: (opts) =>
    set({ gameSidebarOpen: false, gameSidebarPaused: opts?.paused ?? false }),

  setGameSidebarWidth: (width) => set({ gameSidebarWidth: clampGameSidebarWidth(width) }),

  setGameSidebarGame: (game) => set({ gameSidebarGame: game }),

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

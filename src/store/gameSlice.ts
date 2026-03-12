import type { StateCreator } from "zustand";
import type { CrosswordPuzzle } from "../types";

export interface HighscoreEntry {
  score: number;
  date: number;
}

type HighscoreGame = "snake" | "twentyFortyEight" | "sudoku";

export interface GameSlice {
  highscores: {
    snake: HighscoreEntry[];
    twentyFortyEight: HighscoreEntry[];
    sudoku: HighscoreEntry[];
  };
  completedCrosswordIds: string[];
  customCrosswords: CrosswordPuzzle[];
  addHighscore: (game: HighscoreGame, score: number) => void;
  markCrosswordCompleted: (id: string) => void;
  addCustomCrossword: (puzzle: CrosswordPuzzle) => void;
}

export const createGameSlice: StateCreator<GameSlice, [], [], GameSlice> = (set) => ({
  highscores: {
    snake: [],
    twentyFortyEight: [],
    sudoku: [],
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

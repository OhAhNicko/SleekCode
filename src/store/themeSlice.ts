import type { StateCreator } from "zustand";
import { DEFAULT_THEME_ID } from "../lib/themes";

export interface ThemeSlice {
  themeId: string;
  setTheme: (id: string) => void;
}

export const createThemeSlice: StateCreator<ThemeSlice, [], [], ThemeSlice> = (
  set
) => ({
  themeId: DEFAULT_THEME_ID,
  setTheme: (id) => set({ themeId: id }),
});

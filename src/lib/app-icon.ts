/**
 * App-icon variants — the Settings > Appearance > "App icon" picker.
 *
 * Each variant is a bundled PNG in src-tauri/icons/variants/ (master SVGs
 * live beside them). Applying a variant swaps the OS window icon (title bar
 * + taskbar) at runtime via `set_app_icon_variant`; the exe / installer /
 * pinned-shortcut icon is compiled in and unaffected, so App.tsx re-applies
 * the persisted choice on every boot.
 */
import { invoke } from "@tauri-apps/api/core";

export type AppIconVariant = "a" | "b" | "c" | "d";

export const DEFAULT_APP_ICON_VARIANT: AppIconVariant = "c";

export const APP_ICON_OPTIONS: ReadonlyArray<{ id: AppIconVariant; name: string }> = [
  { id: "a", name: "Mint field" },
  { id: "b", name: "Little terminal" },
  { id: "c", name: "Stacked panes" },
  { id: "d", name: "Monogram" },
];

/** Swap the OS window icon. Failure is cosmetic-only, so it never throws. */
export async function applyAppIcon(variant: AppIconVariant): Promise<void> {
  try {
    await invoke("set_app_icon_variant", { variant });
  } catch (e) {
    console.warn("[app-icon] failed to set window icon:", e);
  }
}

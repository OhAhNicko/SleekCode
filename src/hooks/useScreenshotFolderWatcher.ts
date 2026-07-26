import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import {
  useClipboardImageStore,
  type ScreenshotEntry,
} from "../store/clipboardImageStore";
import { listRecentScreenshots, readImageDataUri } from "../lib/screenshots";

/**
 * How many existing files to pull in when the watcher starts.
 *
 * Every entry carries a full-resolution data URI (the asset protocol is
 * deliberately disabled — see `read_image_data_uri` in lib.rs), so this is a
 * memory budget, not a UI one: ~12 × 1.5 MB of base64 ≈ 18 MB.
 */
const BACKFILL_LIMIT = 12;

/**
 * Surfaces screenshots that never passed through the clipboard.
 *
 * Windows' Snipping Tool writes every snip to `Pictures\Screenshots` whether or
 * not you copy it, so a folder watch sees captures the 1500ms clipboard poll
 * never learns about. Entries are merged against clipboard-sourced ones in the
 * store (same dimensions + written within 15s = one capture), so a snip that
 * arrives down both paths stays a single row.
 *
 * Off by default; driven entirely by the `watchScreenshotsFolder` setting.
 */
export function useScreenshotFolderWatcher() {
  const enabled = useAppStore((s) => s.watchScreenshotsFolder);
  const folderOverride = useAppStore((s) => s.screenshotsFolderOverride);

  useEffect(() => {
    if (!enabled) return;

    let active = true;
    let unlisten: (() => void) | null = null;

    /** Load the bytes, then hand the entry to the store's merge logic. */
    const ingest = async (entry: ScreenshotEntry) => {
      if (!active) return;
      const store = useClipboardImageStore.getState();
      // Cheap pre-check so a known file never costs a base64 read.
      if (
        store.images.some(
          (im) => im.originalPath === entry.path || im.winPath === entry.path,
        )
      ) {
        return;
      }
      const dataUri = await readImageDataUri(entry.path);
      if (!active || !dataUri) return;
      useClipboardImageStore.getState().addFolderImage(entry, dataUri);
    };

    void (async () => {
      try {
        await invoke<string>("screenshots_watch_start", {
          folder: folderOverride?.trim() || undefined,
        });
      } catch {
        // No folder, or the platform can't watch one. Backfill is pointless
        // too in that case, so stop here rather than half-enabling.
        return;
      }

      if (!active) return;

      const un = await listen<ScreenshotEntry>("made:screenshot-added", (e) => {
        void ingest(e.payload);
      });
      // Cleanup can land mid-`await`, when `unlisten` is still null and there is
      // nothing for it to call. Re-check afterwards and unsubscribe here instead
      // — otherwise a remount (StrictMode's double-effect is the everyday case)
      // leaves the old listener alive and every screenshot event gets handled
      // once per leaked subscription.
      if (!active) {
        un();
        return;
      }
      unlisten = un;

      // Backfill oldest-first so the newest file ends up newest in the list
      // even though each insert re-sorts.
      const recent = await listRecentScreenshots(BACKFILL_LIMIT);
      for (const entry of [...recent].reverse()) {
        if (!active) return;
        // Sequential on purpose — a dozen concurrent multi-MB base64 encodes
        // would spike memory for no perceptible gain.
        await ingest(entry);
      }
    })();

    return () => {
      active = false;
      unlisten?.();
      void invoke("screenshots_watch_stop").catch(() => {});
    };
  }, [enabled, folderOverride]);
}

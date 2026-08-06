import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import {
  useClipboardImageStore,
  type ClipboardImage,
  type ScreenshotEntry,
} from "../store/clipboardImageStore";
import { useAnnotationStore } from "../store/screenshotAnnotationStore";
import { flattenToPng, isRealCrop, saveAnnotated } from "./annotations";
import { openScreenshotViewer } from "./screenshot-viewer";

/** Mirrors Rust's `DeleteReport`. */
export interface DeleteReport {
  deleted: string[];
  skipped: string[];
}

/** The folder override from settings, normalised to `undefined` when unset. */
function folderArg(): string | undefined {
  const raw = useAppStore.getState().screenshotsFolderOverride?.trim();
  return raw ? raw : undefined;
}

/** Resolve the effective Screenshots folder (override, else OS detection). */
export async function resolveScreenshotsFolder(): Promise<string | null> {
  try {
    return await invoke<string>("screenshots_resolve_folder", { folder: folderArg() });
  } catch {
    return null;
  }
}

export async function listRecentScreenshots(limit: number): Promise<ScreenshotEntry[]> {
  try {
    return await invoke<ScreenshotEntry[]>("screenshots_list_recent", {
      folder: folderArg(),
      limit,
    });
  } catch {
    return [];
  }
}

/**
 * Look up the `Pictures\Screenshots` original that corresponds to a temp copy.
 * Returns null when the folder is unreachable or nothing matched — the caller
 * must treat that as "there is only the temp copy", never as an error.
 */
export async function findOriginal(tempPath: string): Promise<ScreenshotEntry | null> {
  try {
    return await invoke<ScreenshotEntry | null>("screenshots_find_original", {
      tempPath,
      folder: folderArg(),
    });
  } catch {
    return null;
  }
}

/**
 * Which files on disk this screenshot actually owns.
 *
 * `winPath` is whichever path the entry adopted, so it can be either copy —
 * fold it into the right slot rather than passing it twice.
 */
export function filesFor(img: ClipboardImage): { tempPath?: string; originalPath?: string } {
  const tempPath = img.tempPath ?? (img.originalPath ? undefined : img.winPath);
  const originalPath = img.originalPath;
  return { tempPath, originalPath };
}

/**
 * Delete a screenshot from disk, then drop it from the session list.
 *
 * The list entry goes even when the unlink partially fails: leaving a row that
 * points at a file the user just asked to destroy is worse than losing the row.
 * Rust validates both paths against their roots — see `screenshots_delete`.
 */
export async function deleteScreenshot(img: ClipboardImage): Promise<DeleteReport> {
  // Project images opened from the file tree are viewed, not owned — removing
  // one from the list must never unlink a repo asset. (Rust's root guards
  // would skip the unlink anyway; this branch makes the no-op explicit so the
  // UI can label it "Remove from list".)
  if (img.source === "external") {
    useClipboardImageStore.getState().removeImage(img.id);
    return { deleted: [], skipped: [] };
  }
  const { tempPath, originalPath } = filesFor(img);
  let report: DeleteReport = { deleted: [], skipped: [] };
  try {
    report = await invoke<DeleteReport>("screenshots_delete", {
      tempPath,
      originalPath,
      folder: folderArg(),
    });
  } catch (e) {
    report = { deleted: [], skipped: [String(e)] };
  }
  useClipboardImageStore.getState().removeImage(img.id);
  return report;
}

/** Delete every listed screenshot, then empty the list. */
export async function deleteAllScreenshots(images: ClipboardImage[]): Promise<DeleteReport> {
  const results = await Promise.all(
    images.map(async (img) => {
      // Same rule as deleteScreenshot: external rows leave the file alone.
      if (img.source === "external") return { deleted: [], skipped: [] } as DeleteReport;
      const { tempPath, originalPath } = filesFor(img);
      try {
        return await invoke<DeleteReport>("screenshots_delete", {
          tempPath,
          originalPath,
          folder: folderArg(),
        });
      } catch (e) {
        return { deleted: [], skipped: [String(e)] } as DeleteReport;
      }
    }),
  );
  useClipboardImageStore.getState().clearAll();
  return {
    deleted: results.flatMap((r) => r.deleted),
    skipped: results.flatMap((r) => r.skipped),
  };
}

/** How many files `deleteScreenshot` would remove — drives the confirm copy. */
export function fileCount(img: ClipboardImage): number {
  const { tempPath, originalPath } = filesFor(img);
  return (tempPath ? 1 : 0) + (originalPath ? 1 : 0);
}

/** Read an image file off disk as a data URI (folder-sourced entries). */
export async function readImageDataUri(path: string): Promise<string | null> {
  try {
    return await invoke<string>("read_image_data_uri", { path });
  } catch {
    return null;
  }
}

/** Pixel dimensions of a data URI, measured by the decoder. */
export function measureDataUri(dataUri: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataUri;
  });
}

/**
 * The image the user actually sees — markup baked in.
 *
 * Anything that hands a screenshot onward (attach to a prompt, insert a path,
 * copy to the clipboard) has to go through here. Unsaved markup is still markup:
 * marking something up and then attaching the untouched original is the exact
 * failure the edit feature exists to prevent, and it is silent, so the caller
 * never finds out.
 *
 * Flattening produces a NEW screenshot row and leaves the original alone. When
 * there is nothing to bake, the original is returned untouched and no file is
 * written.
 */
export async function materializeMarkup(img: ClipboardImage): Promise<ClipboardImage> {
  const ann = useAnnotationStore.getState();
  const shapes = ann.shapes[img.id] ?? [];
  const rawCrop = ann.crop[img.id] ?? null;

  // Dimensions come from the image itself, never from whatever the viewer
  // happens to have on screen — this runs for the topbar strip too, where no
  // viewer is open at all.
  let natural = img.width && img.height ? { w: img.width, h: img.height } : null;
  if (!natural) {
    const measured = await measureDataUri(img.dataUri);
    if (!measured) return img;
    natural = { w: measured.width, h: measured.height };
  }

  const crop = isRealCrop(rawCrop, natural) ? rawCrop!.rect : null;
  if (shapes.length === 0 && !crop) return img;

  try {
    const base64 = await flattenToPng(img.dataUri, shapes, crop, natural);
    const saved = await saveAnnotated(base64);
    const id = useClipboardImageStore.getState().addDerivedImage({
      winPath: saved.path,
      // tempPath too — it is what `filesFor` hands the delete guard, so
      // without it the export could never be removed from the UI.
      tempPath: saved.path,
      dataUri: saved.data_uri,
      width: Math.round(crop?.w ?? natural.w),
      height: Math.round(crop?.h ?? natural.h),
      bytes: dataUriBytes(saved.data_uri),
      source: "clipboard",
    });
    // The markup is a file now; leaving it armed would re-export on next use.
    useAnnotationStore.getState().clear(img.id);
    return useClipboardImageStore.getState().images.find((im) => im.id === id) ?? img;
  } catch {
    // Never block the user's action on an export failure — hand back what we
    // have rather than dropping the attach on the floor.
    return img;
  }
}

export interface OverwriteReport {
  written: string[];
  skipped: string[];
}

/**
 * Save the markup back over the screenshot's own files — the temp copy and the
 * `Pictures\Screenshots` original both.
 *
 * DESTRUCTIVE, and the only destructive path in the editor: unlike "Save as
 * new", the un-annotated picture does not survive this. Rust validates both
 * paths against their roots and refuses to write PNG bytes into a non-PNG file
 * (see `screenshots_overwrite`).
 *
 * On success the row keeps its id and paths — the files it points at are the
 * ones that changed — and only its pixels, dimensions and size are refreshed.
 */
export async function saveMarkupInPlace(img: ClipboardImage): Promise<OverwriteReport> {
  const ann = useAnnotationStore.getState();
  const shapes = ann.shapes[img.id] ?? [];
  const rawCrop = ann.crop[img.id] ?? null;

  let natural = img.width && img.height ? { w: img.width, h: img.height } : null;
  if (!natural) {
    const measured = await measureDataUri(img.dataUri);
    if (!measured) return { written: [], skipped: ["Could not read the image"] };
    natural = { w: measured.width, h: measured.height };
  }

  const crop = isRealCrop(rawCrop, natural) ? rawCrop!.rect : null;
  if (shapes.length === 0 && !crop) return { written: [], skipped: [] };

  const { tempPath, originalPath } = filesFor(img);
  try {
    const base64 = await flattenToPng(img.dataUri, shapes, crop, natural);
    const report = await invoke<OverwriteReport>("screenshots_overwrite", {
      base64Png: base64,
      tempPath,
      originalPath,
      folder: folderArg(),
    });
    // Nothing landed on disk — leave the markup armed so the user can retry
    // rather than silently discarding their work.
    if (report.written.length === 0) return report;

    useClipboardImageStore.getState().replaceImageBytes(img.id, {
      dataUri: `data:image/png;base64,${base64}`,
      width: Math.round(crop?.w ?? natural.w),
      height: Math.round(crop?.h ?? natural.h),
      bytes: dataUriBytes(base64),
    });
    useAnnotationStore.getState().clear(img.id);
    return report;
  } catch (e) {
    return { written: [], skipped: [String(e)] };
  }
}

/** Byte length of a base64 data URI payload, without materialising it. */
export function dataUriBytes(dataUri: string): number {
  const comma = dataUri.indexOf(",");
  if (comma < 0) return 0;
  const b64 = dataUri.length - comma - 1;
  const padding = dataUri.endsWith("==") ? 2 : dataUri.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64 * 3) / 4) - padding);
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - timestamp) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs} sec ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Extensions the screenshot viewer can display — the set `read_image_data_uri`
 * accepts (wider than the capture pipeline's png/jpg/bmp: the viewer only has
 * to render, never header-parse).
 */
const VIEWABLE_IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

/** Whether a path names an image the screenshot viewer can open. */
export function isImagePath(path: string): boolean {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return VIEWABLE_IMAGE_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Open an arbitrary on-disk image (a project file from the file tree) in the
 * screenshot viewer. The image joins the session list as an `external` row —
 * visible in the viewer's filmstrip, kept out of the TabBar capture strip.
 *
 * Returns false when the file can't be read (unsupported type, over the 16MB
 * cap, gone) or no viewer is mounted — the caller decides the fallback.
 */
export async function openImageFileInViewer(path: string): Promise<boolean> {
  const dataUri = await readImageDataUri(path);
  return addExternalAndOpen(path, dataUri);
}

/**
 * Same as `openImageFileInViewer` for a file on an SSH server: the bytes come
 * over `ssh_read_image_data_uri` (binary-safe, unlike `ssh_read_file`), the
 * row keeps the remote path.
 */
export async function openRemoteImageInViewer(
  server: { host: string; username: string; identityFile: string | null },
  path: string,
): Promise<boolean> {
  let dataUri: string | null = null;
  try {
    dataUri = await invoke<string>("ssh_read_image_data_uri", {
      host: server.host,
      username: server.username,
      path,
      identityFile: server.identityFile,
    });
  } catch {
    dataUri = null;
  }
  return addExternalAndOpen(path, dataUri);
}

async function addExternalAndOpen(path: string, dataUri: string | null): Promise<boolean> {
  if (!dataUri) return false;
  const dims = await measureDataUri(dataUri);
  const id = useClipboardImageStore.getState().addExternalImage({
    winPath: path,
    originalPath: path,
    dataUri,
    width: dims?.width,
    height: dims?.height,
    bytes: dataUriBytes(dataUri),
    source: "external",
  });
  return openScreenshotViewer(id);
}

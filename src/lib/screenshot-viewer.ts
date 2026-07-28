/**
 * Registry connecting the screenshot viewer to callers outside
 * ClipboardImageStrip (e.g. the image-paste toast). The strip owns the
 * viewer's mount and registers an opener here; a missing registration makes
 * `openScreenshotViewer` a no-op instead of faking success — same pattern as
 * terminal-actions/surface-actions.
 */

type ScreenshotViewerOpener = (imageId: string | null) => void;

let opener: ScreenshotViewerOpener | null = null;

/** Register the opener. Returns an unregister fn that only clears itself. */
export function registerScreenshotViewerOpener(
  fn: ScreenshotViewerOpener,
): () => void {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

/** Open the viewer at `imageId` (null = newest). Returns false if unmounted. */
export function openScreenshotViewer(imageId: string | null): boolean {
  if (!opener) return false;
  opener(imageId);
  return true;
}

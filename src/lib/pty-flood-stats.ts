// Diagnostic aggregate for PTY output volume reaching the JS side.
//
// Every PTY chunk that crosses the Rust->JS channel costs main-thread work
// (the same thread that delivers overlay popup events), so a sustained flood
// here is the leading suspect whenever menus/popups lag. One warn line per
// 2s window, and only when the window actually looks like a flood — silent
// in normal operation.

let chunks = 0;
let bytes = 0;
let timer: ReturnType<typeof setInterval> | null = null;

const WINDOW_MS = 2000;
/** Warn when a 2s window carries more than this many chunks... */
const CHUNK_THRESHOLD = 400;
/** ...or more than this many bytes (2 MB). */
const BYTE_THRESHOLD = 2 * 1024 * 1024;

export function notePtyChunk(byteLength: number): void {
  chunks++;
  bytes += byteLength;
  timer ??= setInterval(() => {
    if (chunks > CHUNK_THRESHOLD || bytes > BYTE_THRESHOLD) {
      console.warn(
        `[PtyFlood] ${chunks} chunks / ${(bytes / 1024).toFixed(0)} KB in last ${WINDOW_MS / 1000}s — main-thread IPC pressure`,
      );
    }
    chunks = 0;
    bytes = 0;
  }, WINDOW_MS);
}

/**
 * Frontend half of the text editor's live reload.
 *
 * The Rust side (`src-tauri/src/file_watch.rs`) watches the parent directory of
 * every registered file and emits `made:file-changed` with the exact path
 * string we registered. This module owns:
 *
 *   - a SINGLE `listen()` subscription for the whole app (one Tauri IPC channel,
 *     not one per open file),
 *   - per-path subscriber sets, so the same file open in several panes wakes all
 *     of them from one event,
 *   - refcounted `watch_file` / `unwatch_file` invokes so the last unsubscribe
 *     actually releases the OS handle,
 *   - a trailing debounce, because one save produces a burst of events (Windows
 *     in particular emits Remove+Create+Modify for an atomic rename-over) and we
 *     only ever care about the state after the burst settles.
 *
 * Trailing edge specifically: a leading-edge debounce would fire on the `Remove`
 * half of an atomic save and read a file that momentarily does not exist.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Burst-coalescing window. Long enough to absorb an atomic save's event storm,
 *  short enough to still feel instant. */
const DEBOUNCE_MS = 120;

type Subscriber = () => void;

const subscribers = new Map<string, Set<Subscriber>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

let unlisten: UnlistenFn | null = null;
let listening = false;

function ensureListener() {
  if (listening) return;
  listening = true;
  listen<{ path: string }>("made:file-changed", (event) => {
    const path = event.payload?.path;
    if (!path || !subscribers.has(path)) return;

    const pending = timers.get(path);
    if (pending) clearTimeout(pending);
    timers.set(
      path,
      setTimeout(() => {
        timers.delete(path);
        // Copy before iterating — a subscriber may unsubscribe itself in
        // response (e.g. the pane closes the file on a disk-delete).
        const listeners = subscribers.get(path);
        if (!listeners) return;
        for (const cb of [...listeners]) {
          try {
            cb();
          } catch {
            /* one bad subscriber must not starve the rest */
          }
        }
      }, DEBOUNCE_MS)
    );
  })
    .then((fn) => {
      unlisten = fn;
      // Raced with a full teardown while the listener was still being
      // registered — drop it immediately rather than leaking the channel.
      if (subscribers.size === 0) {
        unlisten();
        unlisten = null;
        listening = false;
      }
    })
    .catch(() => {
      listening = false;
    });
}

/**
 * Watch `path` for external modification. Returns an unsubscribe function;
 * call it on unmount. Safe to call for the same path from multiple panes.
 */
export function watchFile(path: string, onChange: Subscriber): () => void {
  if (!path) return () => {};

  let set = subscribers.get(path);
  if (!set) {
    set = new Set();
    subscribers.set(path, set);
    ensureListener();
    invoke("watch_file", { path }).catch(() => {
      // Watching is best-effort: an unwatchable path (deleted, permission
      // denied, a UNC share whose backend does not deliver notifications)
      // degrades to "no live reload", never to a broken editor.
    });
  }
  set.add(onChange);

  let released = false;
  return () => {
    if (released) return;
    released = true;

    const current = subscribers.get(path);
    if (!current) return;
    current.delete(onChange);
    if (current.size > 0) return;

    subscribers.delete(path);
    const pending = timers.get(path);
    if (pending) {
      clearTimeout(pending);
      timers.delete(path);
    }
    invoke("unwatch_file", { path }).catch(() => {});

    if (subscribers.size === 0 && unlisten) {
      unlisten();
      unlisten = null;
      listening = false;
    }
  };
}

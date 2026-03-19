import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useState, useEffect, useCallback, useRef } from "react";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "error"
  | "up-to-date";

export interface UpdateState {
  status: UpdateStatus;
  progress: { downloaded: number; total: number | null } | null;
  error: string | null;
  version: string | null;
  notes: string | null;
}

export function useUpdateChecker() {
  const [state, setState] = useState<UpdateState>({
    status: "idle",
    progress: null,
    error: null,
    version: null,
    notes: null,
  });
  const updateRef = useRef<Update | null>(null);

  const checkForUpdate = useCallback(async () => {
    setState((s) => ({ ...s, status: "checking", error: null }));
    try {
      const update = await check();
      if (update) {
        updateRef.current = update;
        setState((s) => ({
          ...s,
          status: "available",
          version: update.version,
          notes: update.body ?? null,
        }));
      } else {
        updateRef.current = null;
        setState((s) => ({ ...s, status: "up-to-date" }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // No published release yet or endpoint unreachable — treat as up-to-date
      const isNoRelease =
        /fetch.*release/i.test(msg) ||
        /404/i.test(msg) ||
        /network/i.test(msg);
      if (isNoRelease) {
        setState((s) => ({ ...s, status: "up-to-date" }));
      } else {
        setState((s) => ({ ...s, status: "error", error: msg }));
      }
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setState((s) => ({
      ...s,
      status: "downloading",
      progress: { downloaded: 0, total: null },
    }));
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            setState((s) => ({
              ...s,
              progress: {
                downloaded: 0,
                total: event.data.contentLength ?? null,
              },
            }));
            break;
          case "Progress":
            setState((s) => ({
              ...s,
              progress: {
                downloaded:
                  (s.progress?.downloaded ?? 0) + (event.data.chunkLength ?? 0),
                total: s.progress?.total ?? null,
              },
            }));
            break;
          case "Finished":
            setState((s) => ({ ...s, status: "installing" }));
            break;
        }
      });
      await relaunch();
    } catch (err) {
      setState((s) => ({
        ...s,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  const dismiss = useCallback(() => {
    setState((s) => ({ ...s, status: "idle", error: null }));
    updateRef.current = null;
  }, []);

  // Check 3s after mount to avoid competing with PTY pool warmup
  useEffect(() => {
    const timer = setTimeout(checkForUpdate, 3000);
    return () => clearTimeout(timer);
  }, [checkForUpdate]);

  return { ...state, checkForUpdate, downloadAndInstall, dismiss };
}

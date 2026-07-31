/**
 * SoundPickerHost — main-webview owner of the per-project notification-sound
 * picker (overlay kind "sound-picker", rendered in OverlayRoot).
 *
 * A standalone always-mounted component rather than TabBar state on purpose:
 * TabBar unmounts entirely in vertical-tab-bar mode, and the picker's owner
 * must outlive whichever bar happened to open it. Opened via the
 * "made:open-sound-picker" CustomEvent dispatched by the tab context menu.
 *
 * The payload is frozen at open (rows + usage chips computed synchronously
 * from the store) so the popup never changes size while visible. Previews
 * mutate nothing; a pick assigns and closes.
 */

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import {
  getProjectColor,
  projectDisplayName,
  SOUND_PRESETS,
} from "../store/recentProjectsSlice";
import { useOverlayPopupAnchor } from "../native-term/useOverlayPopupAnchor";
import { previewSound, type SoundId } from "../lib/notification-sounds";

export interface SoundPickerRow {
  id: string;
  label: string;
  /** Projects currently assigned this sound (capped; `overflow` counts the rest). */
  users: Array<{ name: string; color: string | null }>;
  overflow: number;
}

interface SoundPickerPayload {
  /** Current assignment: sound id, null = "No sound", "unset" = never assigned. */
  current: string | null;
  rows: SoundPickerRow[];
}

const MAX_USER_CHIPS = 2;

function buildPayload(workingDir: string): SoundPickerPayload {
  const s = useAppStore.getState();
  const sounds = s.projectSounds ?? {};
  const cur = sounds[workingDir];
  return {
    current: cur === undefined ? "unset" : cur,
    rows: SOUND_PRESETS.map((preset) => {
      const users = Object.entries(sounds)
        .filter(([, id]) => id === preset.id)
        .map(([path]) => ({
          // Sounds are path-only identity (no serverId), so pass undefined —
          // remote projects fall back to the path basename, which is fine.
          name: projectDisplayName(s.recentProjects, path, undefined),
          color: getProjectColor(s.projectColors?.[path] ?? null),
        }));
      return {
        id: preset.id,
        label: preset.label,
        users: users.slice(0, MAX_USER_CHIPS),
        overflow: Math.max(0, users.length - MAX_USER_CHIPS),
      };
    }),
  };
}

export default function SoundPickerHost() {
  const [picker, setPicker] = useState<{
    workingDir: string;
    payload: SoundPickerPayload;
  } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const { workingDir, tabId } = (e as CustomEvent).detail ?? {};
      if (!workingDir || !tabId) return;
      const el = document.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`);
      if (!el) {
        console.debug("[sound-picker] no anchor element for tab", tabId);
        return;
      }
      anchorRef.current = el;
      setPicker({ workingDir, payload: buildPayload(workingDir) });
    };
    window.addEventListener("made:open-sound-picker", handler);
    return () => window.removeEventListener("made:open-sound-picker", handler);
  }, []);

  useOverlayPopupAnchor({
    id: "sound-picker",
    kind: "sound-picker",
    open: picker !== null,
    anchorRef,
    payload: picker?.payload ?? null,
    onAction: (action) => {
      if (!picker) return;
      if (action === "__dismiss__") {
        setPicker(null);
        return;
      }
      const sep = action.indexOf(":");
      if (sep === -1) return;
      const verb = action.slice(0, sep);
      const arg = action.slice(sep + 1);
      if (verb === "preview") {
        // Stays open — the overlay row skipped closeLocal for this action.
        previewSound(arg as SoundId);
      } else if (verb === "pick") {
        useAppStore
          .getState()
          .setProjectSound(picker.workingDir, arg === "none" ? null : (arg as SoundId));
        setPicker(null);
      }
    },
  });

  return null;
}

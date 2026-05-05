/**
 * Tiny parser for user-configurable hotkey strings like "Ctrl+Alt+Space",
 * "Ctrl+Shift+V", "F9". Modifiers in any order, case-insensitive.
 */

export interface ParsedHotkey {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Either a single character (case-insensitive) or a special key name. */
  key: string;
}

const SPECIAL_KEYS: Record<string, string> = {
  space: " ",
  spacebar: " ",
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  backspace: "Backspace",
};

export function parseHotkey(spec: string): ParsedHotkey | null {
  if (!spec) return null;
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  let ctrl = false, alt = false, shift = false, meta = false;
  let key = "";

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") ctrl = true;
    else if (lower === "alt" || lower === "option") alt = true;
    else if (lower === "shift") shift = true;
    else if (lower === "cmd" || lower === "meta" || lower === "win" || lower === "super") meta = true;
    else key = SPECIAL_KEYS[lower] ?? part;
  }
  if (!key) return null;
  return { ctrl, alt, shift, meta, key };
}

export function matchesHotkey(e: KeyboardEvent, spec: string): boolean {
  const parsed = parseHotkey(spec);
  if (!parsed) return false;
  if (e.ctrlKey !== parsed.ctrl) return false;
  if (e.altKey !== parsed.alt) return false;
  if (e.shiftKey !== parsed.shift) return false;
  if (e.metaKey !== parsed.meta) return false;
  // Compare ignoring case for letters; exact match for special keys.
  const k = e.key;
  if (parsed.key.length === 1) {
    return k.toLowerCase() === parsed.key.toLowerCase();
  }
  return k === parsed.key;
}

/**
 * Permissive matcher used for keyup in hold-to-talk mode.
 *
 * Fires true if the RELEASED key is any part of the hotkey combo — either the
 * main key or any modifier. Modifier state of `e` is intentionally ignored
 * because the user releases keys one at a time; if we required the exact
 * modifier state to match, the release event after the user lifts (say) Ctrl
 * first would never fire and recording would hang.
 */
export function matchesHotkeyRelease(e: KeyboardEvent, spec: string): boolean {
  const parsed = parseHotkey(spec);
  if (!parsed) return false;
  const k = e.key;
  // Released the main key?
  if (parsed.key.length === 1) {
    if (k.toLowerCase() === parsed.key.toLowerCase()) return true;
  } else if (k === parsed.key) {
    return true;
  }
  // Released a modifier that's part of the combo?
  if (parsed.ctrl && (k === "Control")) return true;
  if (parsed.alt && (k === "Alt")) return true;
  if (parsed.shift && (k === "Shift")) return true;
  if (parsed.meta && (k === "Meta" || k === "OS")) return true;
  return false;
}

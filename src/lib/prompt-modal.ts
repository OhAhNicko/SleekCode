/**
 * Promise-based text-input / confirmation dialog.
 *
 * Context menus need both — "Rename" needs a name, "Delete" needs a yes — and
 * neither can live in the overlay webview: it is `WS_EX_NOACTIVATE` and can
 * never receive keystrokes. So the dialog renders in the MAIN webview, and
 * `PromptModal` hides the native panes while it is open (a small centred panel
 * would otherwise be painted over by a pane's child HWND, which no z-index can
 * fix).
 *
 * The request crosses as a CustomEvent carrying its own resolver. That is safe
 * here precisely because it never leaves this JS context.
 */
export interface PromptToggle {
  id: string;
  label: string;
  defaultOn?: boolean;
}

/** A second text input under the main one, for a value the dialog needs but
 *  usually already has (the Jira base URL on first run). */
export interface PromptExtraField {
  id: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  /** When true, confirm stays disabled until this field is non-empty too. */
  required?: boolean;
}

export interface PromptRequest {
  title: string;
  /** Omit for a pure confirmation dialog. */
  label?: string;
  initialValue?: string;
  confirmLabel?: string;
  /** Extra line under the title — use it to name what is about to happen. */
  detail?: string;
  /** Red confirm button, for destructive actions. */
  danger?: boolean;
  /** Require typing this exact string to enable confirm (directory deletes). */
  requireTyped?: string;
  /** Checkboxes rendered under the input. Their state comes back through
   *  `promptWithOptions`; `promptForInput` callers ignore them. */
  toggles?: PromptToggle[];
  extraField?: PromptExtraField;
  /** Reject the typed value with an inline message. Runs on every keystroke;
   *  a non-null return keeps confirm disabled. */
  validate?: (value: string) => string | null;
}

export interface PromptResult {
  value: string;
  /** Keyed by toggle id. Absent toggles are simply not in the map. */
  toggles: Record<string, boolean>;
  extra?: string;
}

export interface PromptRequestWithResolver extends PromptRequest {
  /** The modal always resolves with the full result; `promptForInput` narrows
   *  it back to a string so its existing callers are untouched. */
  resolve: (value: PromptResult | null) => void;
}

export const PROMPT_EVENT = "made:prompt";

/**
 * Resolves to the entered text, "" for a bare confirmation, or null if the
 * user cancelled. Callers MUST treat null as "do nothing".
 */
export function promptForInput(req: PromptRequest): Promise<string | null> {
  return promptWithOptions(req).then((r) => (r === null ? null : r.value));
}

/**
 * Full-fidelity variant: resolves with the typed value plus the state of any
 * `toggles` / `extraField` the request declared. Null still means cancelled.
 */
export function promptWithOptions(req: PromptRequest): Promise<PromptResult | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent<PromptRequestWithResolver>(PROMPT_EVENT, {
        detail: { ...req, resolve },
      }),
    );
  });
}

/** Confirmation-only helper. */
export function confirmAction(req: Omit<PromptRequest, "label" | "initialValue">): Promise<boolean> {
  return promptForInput(req).then((v) => v !== null);
}

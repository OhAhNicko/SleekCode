import { registerMenuProvider } from "../registry";
import type { InputCtx } from "../context";
import type { MenuGroup, MenuProvider } from "../types";

/**
 * Text fields (inputs, textareas, contenteditable) — including the prompt
 * composer.
 *
 * `document.execCommand` is legitimate HERE, unlike in a terminal pane: this is
 * a real DOM field with a real DOM selection. The old global menu offered Copy
 * and Paste on every surface in the app using exactly this call, which is why
 * they appeared to work in a composer and did nothing everywhere else.
 *
 * Paste writes through the field's own value so React's onChange fires;
 * `execCommand("paste")` is blocked in Chromium for security.
 */
function pasteIntoField(ctx: InputCtx): void {
  const el = ctx.el as HTMLInputElement | HTMLTextAreaElement;
  navigator.clipboard
    .readText()
    .then((text) => {
      if (!text) return;
      if (typeof el.selectionStart === "number" && typeof el.selectionEnd === "number") {
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const next = el.value.slice(0, start) + text + el.value.slice(end);
        // Native setter so React's synthetic onChange actually fires — setting
        // .value directly is swallowed by React's value tracker.
        const proto =
          el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, next);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        const caret = start + text.length;
        el.setSelectionRange(caret, caret);
      } else {
        el.focus();
        document.execCommand("insertText", false, text);
      }
    })
    .catch(() => {});
}

const inputProvider: MenuProvider<"input"> = {
  id: "input",
  surface: "input",
  order: 5,
  build({ ctx }): MenuGroup[] {
    const noSelection = ctx.hasSelection ? undefined : { reason: "Nothing is selected" };
    return [
      {
        id: "edit",
        items: [
          {
            id: "input.cut",
            label: "Cut",
            iconId: "copy",
            unavailable: ctx.readOnly
              ? { reason: "This field is read-only" }
              : noSelection,
            run: (c) => {
              (c as InputCtx).el.focus();
              document.execCommand("cut");
            },
          },
          {
            id: "input.copy",
            label: "Copy",
            iconId: "copy",
            unavailable: noSelection,
            run: (c) => {
              (c as InputCtx).el.focus();
              document.execCommand("copy");
            },
          },
          {
            id: "input.paste",
            label: "Paste",
            iconId: "paste",
            unavailable: ctx.readOnly ? { reason: "This field is read-only" } : undefined,
            run: (c) => pasteIntoField(c as InputCtx),
          },
          {
            id: "input.selectAll",
            label: "Select all",
            run: (c) => {
              const el = (c as InputCtx).el as HTMLInputElement;
              el.focus();
              el.select?.();
            },
          },
        ],
      },
    ];
  },
};

registerMenuProvider(inputProvider as MenuProvider);

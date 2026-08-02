import { useEffect, useRef, useState } from "react";
import { useModalWhen } from "../store/modalCoordinationSlice";
import { PROMPT_EVENT, type PromptRequestWithResolver } from "../lib/prompt-modal";
import { MODAL_BACKDROP } from "../lib/modal-layout";

/**
 * Single host for `promptForInput` / `confirmAction`.
 *
 * Mounted once in App. `useModalWhen(..., open)` — not `useModal` — because
 * this component lives for the whole session: an unconditional `useModal` would
 * hide every native pane forever.
 */
export default function PromptModal() {
  const [req, setReq] = useState<PromptRequestWithResolver | null>(null);
  const [value, setValue] = useState("");
  const [toggleState, setToggleState] = useState<Record<string, boolean>>({});
  const [extraValue, setExtraValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useModalWhen("prompt-modal", !!req);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<PromptRequestWithResolver>).detail;
      setValue(detail.initialValue ?? "");
      setToggleState(
        Object.fromEntries((detail.toggles ?? []).map((t) => [t.id, !!t.defaultOn])),
      );
      setExtraValue(detail.extraField?.initialValue ?? "");
      setReq(detail);
    };
    window.addEventListener(PROMPT_EVENT, handler);
    return () => window.removeEventListener(PROMPT_EVENT, handler);
  }, []);

  useEffect(() => {
    if (!req) return;
    const t = setTimeout(() => {
      inputRef.current?.focus();
      if (req.masked) return;
      // Preselect the basename so renaming "index.ts" -> "route.ts" doesn't
      // mean re-typing the extension.
      const v = inputRef.current?.value ?? "";
      const dot = v.lastIndexOf(".");
      inputRef.current?.setSelectionRange(0, dot > 0 ? dot : v.length);
    }, 0);
    return () => clearTimeout(t);
  }, [req]);

  if (!req) return null;

  const needsText = req.label !== undefined;
  const isChoices = !!req.choices?.length;
  const typedOk = !req.requireTyped || value === req.requireTyped;
  const validationError = needsText && value.trim() ? (req.validate?.(value.trim()) ?? null) : null;
  const extraOk = !req.extraField?.required || extraValue.trim().length > 0;
  const canConfirm =
    (!needsText || value.trim().length > 0) && typedOk && !validationError && extraOk;

  const reset = () => {
    setReq(null);
    setValue("");
    setToggleState({});
    setExtraValue("");
  };

  const finish = (confirmed: boolean) => {
    req.resolve(
      confirmed
        ? {
            // Masked values (passwords) keep whitespace verbatim.
            value: needsText ? (req.masked ? value : value.trim()) : "",
            toggles: toggleState,
            extra: req.extraField ? extraValue.trim() : undefined,
          }
        : null,
    );
    reset();
  };

  /** Choices dialogs confirm by picking — the chosen id rides `value`. */
  const finishChoice = (choiceId: string) => {
    req.resolve({ value: choiceId, toggles: toggleState });
    reset();
  };

  return (
    <div
      style={{
        ...MODAL_BACKDROP,
        zIndex: 300,
        background: "rgba(0,0,0,0.55)",
      }}
      onClick={() => finish(false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            finish(false);
          } else if (e.key === "Enter" && canConfirm && !isChoices) {
            // Choices dialogs let Enter through so it activates the focused
            // option button instead of confirming with an empty value.
            e.stopPropagation();
            finish(true);
          }
        }}
        style={{
          width: 380,
          maxWidth: "calc(100vw - 32px)",
          borderRadius: "calc(var(--ezy-radius-scale, 1) * 10px)",
          overflow: "hidden",
          background: "var(--ezy-surface-raised, #1c2128)",
          border: "1px solid var(--ezy-border, rgba(255,255,255,0.1))",
          boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
          color: "var(--ezy-text, #e6edf3)",
          fontFamily: "var(--ezy-font-ui, Inter, system-ui, sans-serif)",
        }}
      >
        <div style={{ padding: "16px 18px 12px" }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{req.title}</div>
          {req.detail && (
            <div
              style={{
                fontSize: 12,
                marginTop: 6,
                lineHeight: 1.45,
                color: "var(--ezy-text-muted, rgba(230,237,243,0.6))",
                wordBreak: "break-all",
              }}
            >
              {req.detail}
            </div>
          )}
          {needsText && (
            <>
              <div
                style={{
                  fontSize: 11,
                  marginTop: 14,
                  marginBottom: 5,
                  color: "var(--ezy-text-muted, rgba(230,237,243,0.6))",
                }}
              >
                {req.label}
              </div>
              <input
                ref={inputRef}
                type={req.masked ? "password" : "text"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
                autoComplete={req.masked ? "new-password" : "off"}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "7px 10px",
                  fontSize: 13,
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                  outline: "none",
                  background: "var(--ezy-surface, #161b22)",
                  border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
                  color: "var(--ezy-text, #e6edf3)",
                }}
              />
            </>
          )}
          {validationError && (
            <div style={{ fontSize: 11, marginTop: 6, color: "#e5534b" }}>
              {validationError}
            </div>
          )}
          {req.extraField && (
            <>
              <div
                style={{
                  fontSize: 11,
                  marginTop: 14,
                  marginBottom: 5,
                  color: "var(--ezy-text-muted, rgba(230,237,243,0.6))",
                }}
              >
                {req.extraField.label}
              </div>
              <input
                value={extraValue}
                onChange={(e) => setExtraValue(e.target.value)}
                placeholder={req.extraField.placeholder}
                spellCheck={false}
                autoComplete="off"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "7px 10px",
                  fontSize: 13,
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                  outline: "none",
                  background: "var(--ezy-surface, #161b22)",
                  border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
                  color: "var(--ezy-text, #e6edf3)",
                }}
              />
            </>
          )}
          {isChoices && (
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
              {req.choices!.map((c, idx) => {
                const disabled = !!c.unavailable;
                const sub = disabled ? c.unavailable!.reason : c.detail;
                return (
                  <button
                    key={c.id}
                    // First enabled option takes focus so Enter/Tab work
                    // without reaching for the mouse.
                    autoFocus={idx === req.choices!.findIndex((x) => !x.unavailable)}
                    disabled={disabled}
                    onClick={() => finishChoice(c.id)}
                    onMouseEnter={(e) => {
                      if (!disabled)
                        e.currentTarget.style.borderColor = "var(--ezy-accent, #10a37f)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor =
                        "var(--ezy-border, rgba(255,255,255,0.12))";
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "9px 12px",
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                      border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
                      background: "var(--ezy-surface, #161b22)",
                      color: "var(--ezy-text, #e6edf3)",
                      cursor: disabled ? "default" : "pointer",
                      opacity: disabled ? 0.45 : 1,
                      fontFamily: "inherit",
                      transition: "border-color 0.15s",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{c.label}</div>
                    {sub && (
                      <div
                        style={{
                          fontSize: 11,
                          marginTop: 2,
                          lineHeight: 1.4,
                          color: "var(--ezy-text-muted, rgba(230,237,243,0.6))",
                        }}
                      >
                        {sub}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {req.toggles && req.toggles.length > 0 && (
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              {req.toggles.map((t) => (
                <label
                  key={t.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    cursor: "pointer",
                    color: "var(--ezy-text, #e6edf3)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!toggleState[t.id]}
                    onChange={(e) =>
                      setToggleState((prev) => ({ ...prev, [t.id]: e.target.checked }))
                    }
                    style={{ accentColor: "var(--ezy-accent, #10a37f)", cursor: "pointer" }}
                  />
                  {t.label}
                </label>
              ))}
            </div>
          )}
          {req.requireTyped && (
            <div
              style={{
                fontSize: 11,
                marginTop: 8,
                color: "var(--ezy-text-muted, rgba(230,237,243,0.6))",
              }}
            >
              Type <strong style={{ color: "var(--ezy-text, #e6edf3)" }}>{req.requireTyped}</strong> to confirm.
            </div>
          )}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 18px 14px",
          }}
        >
          <button
            onClick={() => finish(false)}
            style={{
              padding: "6px 14px",
              fontSize: 12,
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
              cursor: "pointer",
              border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
              background: "transparent",
              color: "var(--ezy-text, #e6edf3)",
            }}
          >
            Cancel
          </button>
          {/* Choices dialogs confirm by picking an option — no OK button. */}
          {!isChoices && (
            <button
              disabled={!canConfirm}
              onClick={() => finish(true)}
              style={{
                padding: "6px 14px",
                fontSize: 12,
                fontWeight: 600,
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                border: "none",
                cursor: canConfirm ? "pointer" : "default",
                opacity: canConfirm ? 1 : 0.45,
                // Solid opaque fill, per the app's badge/button rule.
                background: req.danger ? "#c9302c" : "var(--ezy-accent, #10a37f)",
                color: "#fff",
              }}
            >
              {req.confirmLabel ?? "OK"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

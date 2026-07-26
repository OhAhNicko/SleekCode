import { useEffect, useRef, useState } from "react";
import { useModalWhen } from "../store/modalCoordinationSlice";
import { PROMPT_EVENT, type PromptRequestWithResolver } from "../lib/prompt-modal";

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
  const typedOk = !req.requireTyped || value === req.requireTyped;
  const validationError = needsText && value.trim() ? (req.validate?.(value.trim()) ?? null) : null;
  const extraOk = !req.extraField?.required || extraValue.trim().length > 0;
  const canConfirm =
    (!needsText || value.trim().length > 0) && typedOk && !validationError && extraOk;

  const finish = (confirmed: boolean) => {
    req.resolve(
      confirmed
        ? {
            value: needsText ? value.trim() : "",
            toggles: toggleState,
            extra: req.extraField ? extraValue.trim() : undefined,
          }
        : null,
    );
    setReq(null);
    setValue("");
    setToggleState({});
    setExtraValue("");
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
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
          } else if (e.key === "Enter" && canConfirm) {
            e.stopPropagation();
            finish(true);
          }
        }}
        style={{
          width: 380,
          maxWidth: "calc(100vw - 32px)",
          borderRadius: 10,
          overflow: "hidden",
          background: "var(--ezy-surface-raised, #1c2128)",
          border: "1px solid var(--ezy-border, rgba(255,255,255,0.1))",
          boxShadow: "0 16px 48px rgba(0,0,0,0.55)",
          color: "var(--ezy-text, #e6edf3)",
          fontFamily: "Inter, system-ui, sans-serif",
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
                value={value}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "7px 10px",
                  fontSize: 13,
                  borderRadius: 6,
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
                  borderRadius: 6,
                  outline: "none",
                  background: "var(--ezy-surface, #161b22)",
                  border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
                  color: "var(--ezy-text, #e6edf3)",
                }}
              />
            </>
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
              borderRadius: 6,
              cursor: "pointer",
              border: "1px solid var(--ezy-border, rgba(255,255,255,0.12))",
              background: "transparent",
              color: "var(--ezy-text, #e6edf3)",
            }}
          >
            Cancel
          </button>
          <button
            disabled={!canConfirm}
            onClick={() => finish(true)}
            style={{
              padding: "6px 14px",
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 6,
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
        </div>
      </div>
    </div>
  );
}

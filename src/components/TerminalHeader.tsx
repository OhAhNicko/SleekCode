import { useState, useEffect } from "react";
import type { TerminalType } from "../types";
import type { ContextInfo } from "../lib/context-parser";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";
import { FaChevronDown, FaCheck } from "react-icons/fa";
import { FaXmark, FaGripVertical } from "react-icons/fa6";

const TOOL_ORDER: TerminalType[] = ["claude", "codex", "gemini", "shell"];

/** Brand colors for each CLI — used for header underline */
export const CLI_BRAND_COLORS: Record<TerminalType, string> = {
  claude: "#D97757",
  codex: "#10a37f",
  gemini: "#8E75B2",
  shell: "var(--ezy-text-muted)",
  devserver: "var(--ezy-text-muted)",
};


interface TerminalHeaderProps {
  terminalId: string;
  terminalType: TerminalType;
  isActive: boolean;
  onChangeType: (type: TerminalType) => void;
  onClose: () => void;
  onSwapPane?: (fromTerminalId: string, toTerminalId: string) => void;
  serverName?: string;
  isYolo?: boolean;
  contextInfo?: ContextInfo | null;
}

function TerminalIcon({ type }: { type: TerminalType }) {
  const size = 14;
  switch (type) {
    case "claude":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <path
            d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
            fill="#D97757"
          />
        </svg>
      );
    case "codex":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <path
            d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"
            fill="#10a37f"
          />
        </svg>
      );
    case "gemini":
      return (
        <svg width={size} height={size} viewBox="0 0 24 24">
          <path
            d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"
            fill="#8E75B2"
          />
        </svg>
      );
    case "shell":
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
          <rect
            x="1.5"
            y="2.5"
            width="13"
            height="11"
            rx="1.5"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1"
          />
          <path
            d="M4.5 6L6.5 8L4.5 10"
            stroke="var(--ezy-accent)"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <line
            x1="8"
            y1="10"
            x2="11"
            y2="10"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

/** Compact CLI picker dropdown used for split and type-switch */
function CliPicker({
  onSelect,
  onClose,
  currentType,
}: {
  onSelect: (type: TerminalType) => void;
  onClose: () => void;
  currentType?: TerminalType;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      {/* Backdrop to catch clicks outside (Tauri drag region swallows mousedown) */}
      <div
        style={{ position: "fixed", inset: 0, zIndex: 199 }}
        onMouseDown={onClose}
      />
      <div
        className="dropdown-enter"
        style={{
          position: "absolute",
          top: "100%",
          left: 0,
          marginTop: 2,
          width: 180,
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
          zIndex: 200,
        }}
      >
      {TOOL_ORDER.map((type) => {
        const config = TERMINAL_CONFIGS[type];
        const isCurrent = type === currentType;
        return (
          <button
            key={type}
            className="w-full text-left"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 10px",
              backgroundColor: isCurrent ? "var(--ezy-accent-glow)" : "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: isCurrent ? 600 : 400,
              color: isCurrent ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
              fontFamily: "inherit",
            }}
            onMouseEnter={(e) => {
              if (!isCurrent) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)";
            }}
            onMouseLeave={(e) => {
              if (!isCurrent) e.currentTarget.style.backgroundColor = "transparent";
            }}
            onClick={() => {
              onSelect(type);
              onClose();
            }}
          >
            <TerminalIcon type={type} />
            <span>{config.label}</span>
            {isCurrent && (
              <FaCheck size={10} color="var(--ezy-accent)" style={{ marginLeft: "auto" }} />
            )}
          </button>
        );
      })}
    </div>
    </>
  );
}

export default function TerminalHeader({
  terminalId,
  terminalType,
  isActive,
  onChangeType,
  onClose,
  onSwapPane,
  serverName,
  isYolo = false,
  contextInfo,
}: TerminalHeaderProps) {
  const contextPercent = contextInfo?.percent ?? null;
  const config = TERMINAL_CONFIGS[terminalType];
  const [showTypePicker, setShowTypePicker] = useState(false);
  return (
    <div
      className="flex items-center select-none group"
      style={{
        height: 28,
        backgroundColor: isActive ? "var(--ezy-surface-raised)" : "var(--ezy-surface)",
        borderBottom: `2px solid ${isActive ? CLI_BRAND_COLORS[terminalType] : "var(--ezy-border)"}`,
        padding: "0 6px 0 0",
        transition: "border-color 200ms ease, background-color 200ms ease",
      }}
    >
      {/* Drag handle — custom pointer drag (HTML5 DnD doesn't work in Tauri WebView2) */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          document.documentElement.classList.add("ezy-dragging-pane");

          // Clear any prior highlights
          document.querySelectorAll("[data-terminal-id]").forEach((el) => {
            (el as HTMLElement).style.outline = "";
          });

          const handleMouseMove = (ev: MouseEvent) => {
            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            const pane = el?.closest("[data-terminal-id]") as HTMLElement | null;
            const hoveredId = pane?.getAttribute("data-terminal-id");

            document.querySelectorAll("[data-terminal-id]").forEach((p) => {
              const pid = p.getAttribute("data-terminal-id");
              (p as HTMLElement).style.outline =
                pid === hoveredId && hoveredId !== terminalId
                  ? "2px solid var(--ezy-accent)"
                  : "";
            });
          };

          const handleMouseUp = (ev: MouseEvent) => {
            document.documentElement.classList.remove("ezy-dragging-pane");
            document.removeEventListener("mousemove", handleMouseMove, true);
            document.removeEventListener("mouseup", handleMouseUp, true);

            // Remove all highlights
            document.querySelectorAll("[data-terminal-id]").forEach((el) => {
              (el as HTMLElement).style.outline = "";
            });

            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            const pane = el?.closest("[data-terminal-id]") as HTMLElement | null;
            const targetId = pane?.getAttribute("data-terminal-id");

            if (targetId && targetId !== terminalId && onSwapPane) {
              onSwapPane(terminalId, targetId);
            }
          };

          // Use capture phase so xterm.js stopPropagation() can't block us
          document.addEventListener("mousemove", handleMouseMove, true);
          document.addEventListener("mouseup", handleMouseUp, true);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: "100%",
          cursor: "grab",
          flexShrink: 0,
          opacity: 0.4,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.8"; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.4"; }}
        title="Drag to rearrange"
      >
        <FaGripVertical size={12} color="var(--ezy-text-muted)" />
      </div>
      {/* Left: type badge — clickable to switch CLI */}
      <div style={{ position: "relative", marginLeft: 3 }}>
        <div
          className="flex items-center gap-1.5"
          style={{ cursor: "pointer", borderRadius: 4, padding: "2px 4px", margin: "-2px -4px" }}
          onClick={() => setShowTypePicker((v) => !v)}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
        >
          <TerminalIcon type={terminalType} />
          <span
            className="text-[11px] font-medium tracking-wide"
            style={{
              color: isActive ? "var(--ezy-text)" : "var(--ezy-text-muted)",
              letterSpacing: "0.04em",
            }}
          >
            {config.label}
            {serverName && (
              <span style={{ color: "var(--ezy-cyan)", marginLeft: 2 }}>
                @ {serverName}
              </span>
            )}
          </span>
          {isYolo && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.06em",
                lineHeight: 1,
                padding: "1px 4px",
                borderRadius: 3,
                backgroundColor: "var(--ezy-red, #e55)",
                color: "#fff",
              }}
            >
              YOLO
            </span>
          )}
          <FaChevronDown size={8} color="var(--ezy-text-muted)" />
        </div>
        {showTypePicker && (
          <CliPicker
            currentType={terminalType}
            onSelect={(type) => {
              if (type !== terminalType) onChangeType(type);
            }}
            onClose={() => setShowTypePicker(false)}
          />
        )}
      </div>

      {/* Model name + context usage indicator — CLI panes only */}
      {contextPercent != null && contextInfo && (
        <div
          className="ml-auto flex items-center gap-2"
          title={`${contextInfo.remaining.toLocaleString()} / ${contextInfo.window.toLocaleString()} = ${contextPercent.toFixed(2)}%`}
          style={{ marginRight: 6 }}
        >
          {contextInfo.model && (
            <span
              style={{
                fontSize: 10,
                color: "var(--ezy-text-muted)",
                lineHeight: 1,
                whiteSpace: "nowrap",
                opacity: 0.7,
              }}
            >
              {contextInfo.model}
            </span>
          )}
          {/* Rate limits — left of context bar (show remaining, not used) */}
          {contextInfo.rateLimitFiveHour != null && (() => {
            const left = Math.round((100 - contextInfo.rateLimitFiveHour) * 100) / 100;
            const isGemini = terminalType === "gemini";
            const label = isGemini ? "RPD" : "5h";
            const tooltip = isGemini
              ? `Daily rate limit: ${left}% left (${contextInfo.rateLimitFiveHour}% used)`
              : `5h rate limit: ${left}% left (${contextInfo.rateLimitFiveHour}% used)`;
            return (
              <span
                title={tooltip}
                style={{
                  fontSize: 9,
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                  color: left <= 20 ? "var(--ezy-red)" : "var(--ezy-text-muted)",
                  opacity: left <= 20 ? 1 : 0.6,
                }}
              >
                {label}:{left}%
              </span>
            );
          })()}
          {contextInfo.rateLimitWeekly != null && terminalType !== "gemini" && (() => {
            const left = Math.round((100 - contextInfo.rateLimitWeekly) * 100) / 100;
            return (
              <span
                title={`Weekly rate limit: ${left}% left (${contextInfo.rateLimitWeekly}% used)`}
                style={{
                  fontSize: 9,
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                  color: left <= 20 ? "var(--ezy-red)" : "var(--ezy-text-muted)",
                  opacity: left <= 20 ? 1 : 0.6,
                }}
              >
                W:{left}%
              </span>
            );
          })()}
          {/* Context bar + percentage */}
          <div
            style={{
              width: 44,
              height: 4,
              borderRadius: 2,
              backgroundColor: "var(--ezy-border)",
              overflow: "hidden",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: `${contextPercent}%`,
                height: "100%",
                borderRadius: 2,
                backgroundColor:
                  contextPercent <= 15
                    ? "var(--ezy-red)"
                    : contextPercent <= 40
                      ? "var(--ezy-text-muted)"
                      : "var(--ezy-accent)",
                transition: "width 500ms ease, background-color 500ms ease",
              }}
            />
          </div>
          <span
            style={{
              fontSize: 10,
              fontVariantNumeric: "tabular-nums",
              color:
                contextPercent <= 15
                  ? "var(--ezy-red)"
                  : contextPercent <= 40
                    ? "var(--ezy-text-muted)"
                    : "var(--ezy-text-muted)",
              lineHeight: 1,
              minWidth: 36,
              textAlign: "right",
            }}
          >
            {contextPercent.toFixed(2)}%
          </span>
        </div>
      )}

      {/* Right: close (visible on header hover) */}
      <div className={`flex items-center gap-0.5 ${contextPercent == null ? "ml-auto" : ""} opacity-0 group-hover:opacity-100 transition-opacity`}>
        <button
          onClick={onClose}
          title="Close Pane (Ctrl+Shift+W)"
          className="p-1 rounded transition-colors hover:bg-[var(--ezy-border)]"
        >
          <FaXmark
            size={12}
            color="var(--ezy-text-muted)"
            className="hover:!text-[var(--ezy-red)]"
          />
        </button>
      </div>
    </div>
  );
}

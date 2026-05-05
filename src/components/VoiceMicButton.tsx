import { useAppStore } from "../store";

/**
 * Visible mic button. Click toggles recording (delegated to <VoiceController />
 * via "ezydev:voice-toggle"). Right-click opens the Settings panel so the user
 * can configure endpoints.
 *
 * `size="topbar"` matches the horizontal-mode action button grammar
 * (34×26, icon scale 1.5×).
 *
 * `size="vertical"` is bigger (38×38, icon scale 1.6×) for the vertical-mode
 * bottom cluster where there's more room and the surrounding ClipboardImageStrip
 * tiles read large too.
 */
export default function VoiceMicButton({ size = "topbar" }: { size?: "topbar" | "vertical" }) {
  const enabled = useAppStore((s) => s.voiceEnabled);
  const state = useAppStore((s) => s.voiceHudState);
  const mode = useAppStore((s) => s.voiceActivationMode);
  const toggleSettings = useAppStore((s) => s.toggleSettingsPanel);

  if (!enabled) return null;

  const isActive = state === "listening";
  const stroke = isActive ? "var(--ezy-red)" : "var(--ezy-text-muted)";
  const isHold = mode === "hold";

  const dim = size === "vertical"
    ? { width: 38, height: 38, scale: 1.2 }
    : { width: 34, height: 26, scale: 1.2 };

  // Toggle mode: click toggles. Hold mode: pointerdown starts, pointerup/leave stops.
  const handlers = isHold
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          window.dispatchEvent(new Event("ezydev:voice-start"));
        },
        onPointerUp: (e: React.PointerEvent) => {
          try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
          window.dispatchEvent(new Event("ezydev:voice-stop"));
        },
        onPointerCancel: () => window.dispatchEvent(new Event("ezydev:voice-stop")),
      }
    : {
        onClick: () => window.dispatchEvent(new Event("ezydev:voice-toggle")),
      };

  const title = isHold
    ? (isActive ? "Recording — release to send" : "Hold to talk (right-click for settings)")
    : (isActive ? "Stop voice (right-click for settings)" : "Voice agent — click to start (right-click for settings)");

  return (
    <div
      {...handlers}
      onContextMenu={(e) => {
        e.preventDefault();
        toggleSettings();
      }}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        alignSelf: "center",
        width: dim.width,
        height: dim.height,
        cursor: "pointer",
        borderRadius: 4,
        backgroundColor: isActive ? "var(--ezy-accent-glow)" : "transparent",
        transition: "background-color 120ms ease",
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke={stroke}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ transform: `scale(${dim.scale})` }}
      >
        <rect x="6" y="2" width="4" height="8" rx="2" />
        <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0" />
        <line x1="8" y1="12" x2="8" y2="14" />
        <line x1="6" y1="14" x2="10" y2="14" />
      </svg>
    </div>
  );
}

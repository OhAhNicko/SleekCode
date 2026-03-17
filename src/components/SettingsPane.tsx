import { useState } from "react";
import { useAppStore } from "../store";
import { THEMES, getTheme } from "../lib/themes";
import { TERMINAL_CONFIGS } from "../lib/terminal-config";
import { isWindows } from "../lib/platform";
import { DEFAULT_CLI_FONT_SIZE } from "../store/recentProjectsSlice";
import { FaCheck } from "react-icons/fa";
import { STATUSLINE_FEATURES } from "./TerminalHeader";
import type { TerminalType, ComposerExpansion } from "../types";

// ─── Internal sub-components ───────────────────────────────────────────────

function ToggleSwitch({ checked, onChange, color }: { checked: boolean; onChange: (v: boolean) => void; color?: string }) {
  const bg = checked ? (color ?? "var(--ezy-accent)") : "transparent";
  return (
    <div
      onClick={() => onChange(!checked)}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        backgroundColor: bg,
        border: checked ? "none" : "1px solid var(--ezy-border-light)",
        position: "relative",
        transition: "background-color 150ms ease",
        flexShrink: 0,
        cursor: "pointer",
      }}
    >
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          backgroundColor: checked ? "#fff" : "var(--ezy-text-muted)",
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          transition: "left 150ms ease",
        }}
      />
    </div>
  );
}

function SegmentedControl<T extends string>({ options, value, onChange, disabled }: {
  options: { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", borderRadius: 6, border: "1px solid var(--ezy-border)", overflow: "hidden", minWidth: 180 }}>
      {options.map((opt) => {
        const isActive = value === opt.value;
        const isOff = disabled || opt.disabled;
        return (
          <button
            key={opt.value}
            disabled={isOff}
            style={{
              flex: 1,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: isActive ? 600 : 400,
              color: isOff ? "var(--ezy-text-muted)" : isActive ? "var(--ezy-text)" : "var(--ezy-text-muted)",
              backgroundColor: isActive ? "var(--ezy-accent-glow)" : "transparent",
              border: "none",
              cursor: isOff ? "default" : "pointer",
              fontFamily: "inherit",
              transition: "background-color 150ms ease",
              opacity: isOff ? 0.35 : 1,
            }}
            onMouseEnter={(e) => { if (!isActive && !isOff) e.currentTarget.style.backgroundColor = "var(--ezy-surface)"; }}
            onMouseLeave={(e) => { if (!isActive && !isOff) e.currentTarget.style.backgroundColor = "transparent"; }}
            onClick={() => { if (!isOff) onChange(opt.value); }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SettingsSection({ id, title, description, children }: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} style={{ paddingBottom: 32 }}>
      <h2 style={{
        fontSize: 15,
        fontWeight: 600,
        color: "var(--ezy-text)",
        margin: "0 0 4px",
        letterSpacing: "-0.01em",
      }}>{title}</h2>
      {description && (
        <p style={{ fontSize: 12, color: "var(--ezy-text-muted)", margin: "0 0 16px", lineHeight: 1.4 }}>{description}</p>
      )}
      {!description && <div style={{ height: 12 }} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {children}
      </div>
    </section>
  );
}

function SettingsRow({ label, description, children }: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "10px 0",
      gap: 16,
      borderBottom: "1px solid var(--ezy-border-subtle)",
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, color: "var(--ezy-text-secondary)" }}>{label}</div>
        {description && <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginTop: 2, lineHeight: 1.3 }}>{description}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

// ─── Nav sections ──────────────────────────────────────────────────────────

const NAV_SECTIONS = [
  ...(isWindows() ? [{ id: "terminal", label: "Terminal" }] : []),
  { id: "behavior", label: "Behavior" },
  { id: "composer", label: "EzyComposer" },
  { id: "preview", label: "Preview Panes" },
  { id: "codereview", label: "Code Review" },
  { id: "ai", label: "AI Sessions" },
  { id: "cli", label: "CLI Options" },
  { id: "theme", label: "Theme" },
  { id: "links", label: "Snippets & Shortcuts" },
];

// ─── Main component ───────────────────────────────────────────────────────

export default function SettingsPane() {
  const [activeSection, setActiveSection] = useState(NAV_SECTIONS[0]?.id ?? "behavior");

  // Store selectors
  const terminalBackend = useAppStore((s) => s.terminalBackend ?? "wsl");
  const setTerminalBackend = useAppStore((s) => s.setTerminalBackend);
  const alwaysShowTemplatePicker = useAppStore((s) => s.alwaysShowTemplatePicker);
  const setAlwaysShowTemplatePicker = useAppStore((s) => s.setAlwaysShowTemplatePicker);
  const restoreLastSession = useAppStore((s) => s.restoreLastSession);
  const setRestoreLastSession = useAppStore((s) => s.setRestoreLastSession);
  const autoInsertClipboardImage = useAppStore((s) => s.autoInsertClipboardImage);
  const setAutoInsertClipboardImage = useAppStore((s) => s.setAutoInsertClipboardImage);
  const copyOnSelect = useAppStore((s) => s.copyOnSelect);
  const setCopyOnSelect = useAppStore((s) => s.setCopyOnSelect);
  const showTabPath = useAppStore((s) => s.showTabPath);
  const setShowTabPath = useAppStore((s) => s.setShowTabPath);
  const confirmQuit = useAppStore((s) => s.confirmQuit);
  const setConfirmQuit = useAppStore((s) => s.setConfirmQuit);
  const slashCommandGhostText = useAppStore((s) => s.slashCommandGhostText);
  const setSlashCommandGhostText = useAppStore((s) => s.setSlashCommandGhostText);
  const openPanesInBackground = useAppStore((s) => s.openPanesInBackground);
  const setOpenPanesInBackground = useAppStore((s) => s.setOpenPanesInBackground);
  const autoMinimizeGameOnAiDone = useAppStore((s) => s.autoMinimizeGameOnAiDone);
  const setAutoMinimizeGameOnAiDone = useAppStore((s) => s.setAutoMinimizeGameOnAiDone);
  const autoStartServerCommand = useAppStore((s) => s.autoStartServerCommand);
  const setAutoStartServerCommand = useAppStore((s) => s.setAutoStartServerCommand);
  const promptComposerEnabled = useAppStore((s) => s.promptComposerEnabled);
  const setPromptComposerEnabled = useAppStore((s) => s.setPromptComposerEnabled);
  const promptComposerAlwaysVisible = useAppStore((s) => s.promptComposerAlwaysVisible);
  const setPromptComposerAlwaysVisible = useAppStore((s) => s.setPromptComposerAlwaysVisible);
  const composerExpansion = useAppStore((s) => s.composerExpansion);
  const setComposerExpansion = useAppStore((s) => s.setComposerExpansion);
  const browserFullColumn = useAppStore((s) => s.browserFullColumn);
  const setBrowserFullColumn = useAppStore((s) => s.setBrowserFullColumn);
  const browserSpawnLeft = useAppStore((s) => s.browserSpawnLeft);
  const setBrowserSpawnLeft = useAppStore((s) => s.setBrowserSpawnLeft);
  const codeReviewCollapseAll = useAppStore((s) => s.codeReviewCollapseAll);
  const setCodeReviewCollapseAll = useAppStore((s) => s.setCodeReviewCollapseAll);
  const commitMsgMode = useAppStore((s) => s.commitMsgMode ?? "simple");
  const setCommitMsgMode = useAppStore((s) => s.setCommitMsgMode);
  const shadowAiCli = useAppStore((s) => s.shadowAiCli ?? "claude");
  const setShadowAiCli = useAppStore((s) => s.setShadowAiCli);
  const cliFontSizes = useAppStore((s) => s.cliFontSizes);
  const setCliFontSize = useAppStore((s) => s.setCliFontSize);
  const cliYolo = useAppStore((s) => s.cliYolo);
  const setCliYolo = useAppStore((s) => s.setCliYolo);
  const statuslineToggles = useAppStore((s) => s.statuslineToggles);
  const setStatuslineToggle = useAppStore((s) => s.setStatuslineToggle);
  const themeId = useAppStore((s) => s.themeId);
  const setTheme = useAppStore((s) => s.setTheme);
  const vibrantColors = useAppStore((s) => s.vibrantColors);
  const setVibrantColors = useAppStore((s) => s.setVibrantColors);
  const theme = getTheme(themeId);

  // Render only the active section content
  const renderSection = () => {
    switch (activeSection) {
      case "terminal":
        return (
          <SettingsSection id="terminal" title="Terminal" description="Choose the backend for new terminal instances.">
            <SettingsRow label="Terminal backend">
              <SegmentedControl
                options={[
                  { value: "wsl" as const, label: "WSL" },
                  { value: "windows" as const, label: "Windows" },
                ]}
                value={terminalBackend as "wsl" | "windows"}
                onChange={(v) => setTerminalBackend(v)}
              />
            </SettingsRow>
          </SettingsSection>
        );

      case "behavior":
        return (
          <SettingsSection id="behavior" title="Behavior" description="General application behavior and defaults.">
            <SettingsRow label="Always show layout picker" description="Show the workspace template picker when creating new tabs.">
              <ToggleSwitch checked={alwaysShowTemplatePicker} onChange={setAlwaysShowTemplatePicker} />
            </SettingsRow>
            <SettingsRow label="Restore last session" description="Reopen tabs from the previous session on startup.">
              <ToggleSwitch checked={restoreLastSession} onChange={setRestoreLastSession} />
            </SettingsRow>
            <SettingsRow label="Auto-paste screenshots" description="Automatically insert clipboard images into AI context.">
              <ToggleSwitch checked={autoInsertClipboardImage} onChange={setAutoInsertClipboardImage} />
            </SettingsRow>
            <SettingsRow label="Copy on select" description="Automatically copy selected terminal text to clipboard.">
              <ToggleSwitch checked={copyOnSelect} onChange={setCopyOnSelect} />
            </SettingsRow>
            <SettingsRow label="Show path in tabs" description="Display the project path after the tab name. Double-click name to rename.">
              <ToggleSwitch checked={showTabPath} onChange={setShowTabPath} />
            </SettingsRow>
            <SettingsRow label="Confirm before quitting" description="Show a confirmation dialog when closing the app.">
              <ToggleSwitch checked={confirmQuit} onChange={setConfirmQuit} />
            </SettingsRow>
            <SettingsRow label="Slash command ghost text" description="Show inline autocomplete suggestions for slash commands.">
              <ToggleSwitch checked={slashCommandGhostText} onChange={setSlashCommandGhostText} />
            </SettingsRow>
            <SettingsRow label="Open panes in background" description="New panes open without stealing focus from the current pane.">
              <ToggleSwitch checked={openPanesInBackground} onChange={setOpenPanesInBackground} />
            </SettingsRow>
            <SettingsRow label="Auto-hide games when AI done" description="Minimize game pane when AI task completes.">
              <ToggleSwitch checked={autoMinimizeGameOnAiDone} onChange={setAutoMinimizeGameOnAiDone} />
            </SettingsRow>
            <SettingsRow label="Auto-start server command" description="Restore dev server commands when reopening projects.">
              <ToggleSwitch checked={autoStartServerCommand} onChange={setAutoStartServerCommand} />
            </SettingsRow>
          </SettingsSection>
        );

      case "composer":
        return (
          <SettingsSection id="composer" title="EzyComposer" description="Configure the prompt composer overlay (Ctrl+I).">
            <SettingsRow label="Enable EzyComposer">
              <ToggleSwitch checked={promptComposerEnabled} onChange={setPromptComposerEnabled} />
            </SettingsRow>
            {promptComposerEnabled && (
              <>
                <SettingsRow label="Always visible" description="Keep the composer visible at all times instead of toggle.">
                  <ToggleSwitch checked={promptComposerAlwaysVisible} onChange={setPromptComposerAlwaysVisible} />
                </SettingsRow>
                <SettingsRow label="Expansion direction" description="How the composer expands when typing long prompts.">
                  <SegmentedControl
                    options={[
                      { value: "up" as ComposerExpansion, label: "Up" },
                      { value: "down" as ComposerExpansion, label: "Down" },
                      { value: "scroll" as ComposerExpansion, label: "Scroll" },
                    ]}
                    value={composerExpansion}
                    onChange={setComposerExpansion}
                  />
                </SettingsRow>
              </>
            )}
          </SettingsSection>
        );

      case "preview":
        return (
          <SettingsSection id="preview" title="Preview Panes" description="Configure browser preview pane behavior.">
            <SettingsRow label="Full column" description="Browser pane takes a full column width in split layouts.">
              <ToggleSwitch checked={browserFullColumn} onChange={setBrowserFullColumn} />
            </SettingsRow>
            <SettingsRow label="Spawn on left" description="Open browser preview on the left side instead of right.">
              <ToggleSwitch checked={browserSpawnLeft} onChange={setBrowserSpawnLeft} />
            </SettingsRow>
          </SettingsSection>
        );

      case "codereview":
        return (
          <SettingsSection id="codereview" title="Code Review" description="Configure the built-in code review experience.">
            <SettingsRow label="Collapse all files" description="Start with all file diffs collapsed in code review.">
              <ToggleSwitch checked={codeReviewCollapseAll} onChange={setCodeReviewCollapseAll} />
            </SettingsRow>
            <SettingsRow label="Commit message mode">
              <SegmentedControl
                options={[
                  { value: "empty" as const, label: "Empty" },
                  { value: "simple" as const, label: "Simple" },
                  { value: "advanced" as const, label: "AI" },
                ]}
                value={commitMsgMode}
                onChange={setCommitMsgMode}
              />
            </SettingsRow>
            <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", padding: "4px 0 0", lineHeight: 1.3 }}>
              {commitMsgMode === "empty" && "Start with a blank commit message"}
              {commitMsgMode === "simple" && "Auto-fill from changed filenames"}
              {commitMsgMode === "advanced" && "Generate message via background AI session"}
            </div>
          </SettingsSection>
        );

      case "ai":
        return (
          <SettingsSection id="ai" title="AI Sessions" description="Configure shadow AI provider for background tasks.">
            <SettingsRow label="Shadow AI provider" description="Subscription used for Promptifier and AI commit messages.">
              <SegmentedControl
                options={[
                  { value: "claude" as const, label: "Claude" },
                  { value: "codex" as const, label: "Codex" },
                  { value: "gemini" as const, label: "Gemini", disabled: true },
                ]}
                value={shadowAiCli}
                onChange={(v) => setShadowAiCli(v as "claude" | "codex")}
              />
            </SettingsRow>
          </SettingsSection>
        );

      case "cli":
        return (
          <SettingsSection id="cli" title="CLI Options" description="Per-CLI font size and YOLO mode settings.">
            {(["claude", "codex", "gemini"] as TerminalType[]).map((cliType) => {
              const currentSize = cliFontSizes[cliType] ?? DEFAULT_CLI_FONT_SIZE;
              const isYolo = !!cliYolo[cliType];
              const label = TERMINAL_CONFIGS[cliType].label;
              return (
                <div key={cliType} style={{ paddingBottom: 16, borderBottom: "1px solid var(--ezy-border-subtle)", marginBottom: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ezy-text)", marginBottom: 10 }}>{label}</div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>Font size</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div
                        onClick={() => setCliFontSize(cliType, Math.max(10, currentSize - 1))}
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 4,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: currentSize <= 10 ? "default" : "pointer",
                          opacity: currentSize <= 10 ? 0.3 : 1,
                          backgroundColor: "transparent",
                          border: "1px solid var(--ezy-border-light)",
                          color: "var(--ezy-text-secondary)",
                          fontSize: 14,
                          lineHeight: 1,
                          transition: "background-color 120ms ease",
                        }}
                        onMouseEnter={(e) => { if (currentSize > 10) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                      >
                        -
                      </div>
                      <span style={{ fontSize: 13, color: "var(--ezy-text)", minWidth: 24, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
                        {currentSize}
                      </span>
                      <div
                        onClick={() => setCliFontSize(cliType, Math.min(24, currentSize + 1))}
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 4,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: currentSize >= 24 ? "default" : "pointer",
                          opacity: currentSize >= 24 ? 0.3 : 1,
                          backgroundColor: "transparent",
                          border: "1px solid var(--ezy-border-light)",
                          color: "var(--ezy-text-secondary)",
                          fontSize: 14,
                          lineHeight: 1,
                          transition: "background-color 120ms ease",
                        }}
                        onMouseEnter={(e) => { if (currentSize < 24) e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                      >
                        +
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {isYolo ? (
                        <span style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "2px 5px",
                          borderRadius: 3,
                          backgroundColor: "var(--ezy-red, #e55)",
                          color: "#fff",
                          lineHeight: 1,
                          letterSpacing: "0.06em",
                        }}>YOLO</span>
                      ) : (
                        <span style={{ fontSize: 12, color: "var(--ezy-text-muted)" }}>YOLO</span>
                      )}
                      <span style={{ fontSize: 12, color: "var(--ezy-text-muted)" }}>mode</span>
                    </div>
                    <ToggleSwitch checked={isYolo} onChange={(v) => setCliYolo(cliType, v)} color="var(--ezy-red, #e55)" />
                  </div>
                  {/* Statusline toggles */}
                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--ezy-border-subtle)" }}>
                    <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 6 }}>Statusline</div>
                    {Object.entries(STATUSLINE_FEATURES)
                      .filter(([, feat]) => feat.clis.includes(cliType))
                      .map(([key, feat]) => {
                        const isOn = statuslineToggles[cliType]?.[key] ?? true;
                        return (
                          <div
                            key={key}
                            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0", cursor: "pointer" }}
                            onClick={() => setStatuslineToggle(cliType, key, !isOn)}
                          >
                            <span style={{ fontSize: 12, color: "var(--ezy-text-secondary)" }}>{feat.label}</span>
                            <ToggleSwitch checked={isOn} onChange={(v) => setStatuslineToggle(cliType, key, v)} />
                          </div>
                        );
                      })}
                  </div>
                </div>
              );
            })}
          </SettingsSection>
        );

      case "theme":
        return (
          <SettingsSection id="theme" title="Theme" description="Choose a color theme for the application.">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8, marginBottom: 16 }}>
              {THEMES.map((t) => {
                const isSelected = t.id === themeId;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 12px",
                      borderRadius: 8,
                      border: isSelected ? `2px solid var(--ezy-accent)` : "1px solid var(--ezy-border)",
                      backgroundColor: isSelected ? "var(--ezy-accent-glow)" : "var(--ezy-surface)",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      textAlign: "left",
                      transition: "all 120ms ease",
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.borderColor = "var(--ezy-accent)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.borderColor = "var(--ezy-border)";
                    }}
                  >
                    <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                      <div style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: t.surface.bg }} />
                      <div style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: t.surface.accent }} />
                      <div style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: t.surface.cyan }} />
                    </div>
                    <span style={{ fontSize: 13, fontWeight: isSelected ? 600 : 400, color: isSelected ? "var(--ezy-text)" : "var(--ezy-text-secondary)" }}>
                      {t.name}
                    </span>
                    {isSelected && <FaCheck size={12} color={theme.surface.accent} style={{ marginLeft: "auto" }} />}
                  </button>
                );
              })}
            </div>
            <SettingsRow label="Vibrant colors" description="Use brighter, more saturated accent colors throughout the UI.">
              <ToggleSwitch checked={vibrantColors} onChange={setVibrantColors} />
            </SettingsRow>
          </SettingsSection>
        );

      case "links":
        return (
          <SettingsSection id="links" title="Snippets & Shortcuts">
            <div
              onClick={() => window.dispatchEvent(new Event("ezydev:open-snippets"))}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "12px 0",
                cursor: "pointer",
                borderBottom: "1px solid var(--ezy-border-subtle)",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" strokeLinecap="round">
                <path d="M5.5 2H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V3a1 1 0 00-1-1h-2.5" />
                <path d="M5 5l2 2-2 2" />
                <line x1="8" y1="10" x2="12" y2="10" />
              </svg>
              <span style={{ fontSize: 13, color: "var(--ezy-text-secondary)", flex: 1 }}>Manage Snippets</span>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 4l4 4-4 4" />
              </svg>
            </div>
            <div
              onClick={() => window.dispatchEvent(new Event("ezydev:open-shortcuts"))}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "12px 0",
                cursor: "pointer",
                borderBottom: "1px solid var(--ezy-border-subtle)",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="4" width="14" height="9" rx="1.5" />
                <line x1="4" y1="7" x2="5.5" y2="7" />
                <line x1="7" y1="7" x2="8.5" y2="7" />
                <line x1="10.5" y1="7" x2="12" y2="7" />
                <line x1="4.5" y1="10" x2="11.5" y2="10" />
              </svg>
              <span style={{ fontSize: 13, color: "var(--ezy-text-secondary)", flex: 1 }}>Keyboard Shortcuts</span>
              <span style={{ fontSize: 11, color: "var(--ezy-text-muted)", fontFamily: "monospace" }}>Ctrl+/</span>
            </div>
          </SettingsSection>
        );

      default:
        return null;
    }
  };

  return (
    <div style={{
      display: "flex",
      height: "100%",
      width: 620,
      flexShrink: 0,
      borderRight: "1px solid var(--ezy-border)",
      backgroundColor: "var(--ezy-bg)",
      color: "var(--ezy-text)",
    }}>
      {/* Left nav sidebar */}
      <nav style={{
        width: 160,
        flexShrink: 0,
        borderRight: "1px solid var(--ezy-border)",
        padding: "24px 0",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 1,
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--ezy-text-muted)",
          padding: "0 16px 12px",
        }}>Settings</div>
        {NAV_SECTIONS.map((s) => {
          const isActive = activeSection === s.id;
          return (
            <div
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              style={{
                padding: "7px 16px",
                fontSize: 13,
                color: isActive ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
                fontWeight: isActive ? 600 : 400,
                cursor: "pointer",
                borderLeft: isActive ? `2px solid var(--ezy-accent)` : "2px solid transparent",
                backgroundColor: isActive ? "var(--ezy-accent-glow)" : "transparent",
                transition: "all 120ms ease",
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
              }}
            >
              {s.label}
            </div>
          );
        })}
      </nav>

      {/* Right content area — only the active section */}
      <div style={{
        flex: 1,
        overflowY: "auto",
        padding: "24px 24px 60px",
      }}>
        {renderSection()}
      </div>
    </div>
  );
}

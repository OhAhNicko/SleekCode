import { useEffect, useRef, useState } from "react";
import {
  resolveThickness,
  THICKNESS_PRESETS,
  type CropVariant,
  type Tool,
} from "../lib/annotations";

/** How many inks show before the swatch row is expanded. */
const COLLAPSED_INKS = 4;

/**
 * How long Save stays armed. Matches the viewer's Delete and Clear all — a
 * primed destructive button must not still be primed minutes later.
 */
const ARM_MS = 3500;

interface Props {
  tool: Tool;
  onTool: (t: Tool) => void;
  color: string;
  onColor: (c: string) => void;
  /** Every ink, most-recently-used first. */
  inks: ReadonlyArray<{ id: string; label: string; color: string }>;
  inksExpanded: boolean;
  onToggleInks: () => void;
  /** Index into the size presets — the width itself depends on the tool. */
  thicknessIndex: number;
  onThicknessIndex: (i: number) => void;
  cropVariant: CropVariant;
  onCropVariant: (v: CropVariant) => void;
  open: boolean;
  onToggleOpen: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  hasCrop: boolean;
  /** A crop is drawn but not yet applied. */
  cropPending: boolean;
  onConfirmCrop: () => void;
  onClearCrop: () => void;
  dirty: boolean;
  saving: boolean;
  /** Overwrite the screenshot's own files. */
  onSave: () => void;
  /** How many files Save would overwrite — named in the confirm. */
  saveTargets: number;
  /** Write a new screenshot and leave the original alone. */
  onSaveAsNew: () => void;
}

const TOOLS: ReadonlyArray<{ id: Tool; label: string; key: string; icon: React.ReactNode }> = [
  {
    id: "select",
    label: "Select",
    key: "V",
    icon: (
      <path d="M3 2 L3 9.5 L5.1 7.6 L6.6 10.4 L8 9.7 L6.6 7 L9 6.8 Z" fill="currentColor" stroke="none" />
    ),
  },
  {
    id: "marker",
    label: "Highlighter",
    key: "H",
    icon: (
      <>
        <path d="M2.5 9.5 L4 6.5 L8.5 2 L10 3.5 L5.5 8 Z" />
        <path d="M2 10.6 H6.5" strokeWidth="1.6" />
      </>
    ),
  },
  {
    id: "rect",
    label: "Rectangle",
    key: "R",
    icon: <rect x="2" y="3" width="8" height="6" rx="0.5" />,
  },
  {
    id: "ellipse",
    label: "Circle",
    key: "E",
    icon: <ellipse cx="6" cy="6" rx="4" ry="3.2" />,
  },
  {
    id: "arrow",
    label: "Arrow",
    key: "A",
    icon: (
      <>
        <path d="M2.5 9.5 L9.5 2.5" />
        <path d="M6.2 2.5 H9.5 V5.8" />
      </>
    ),
  },
  {
    id: "crop",
    label: "Crop",
    key: "C",
    icon: (
      <>
        <path d="M3.5 1 V8.5 H11" />
        <path d="M1 3.5 H8.5 V11" />
      </>
    ),
  },
];

/**
 * Markup toolbar: tools, ink, weight, history, save.
 *
 * Every control here is a `<div>` rather than a `<button>` — buttons inherit
 * `line-height: 1.5` and silently inflate a compact row well past its declared
 * height, which is a documented trap in this codebase.
 */
export default function ScreenshotAnnotationToolbar({
  tool,
  onTool,
  color,
  onColor,
  inks,
  inksExpanded,
  onToggleInks,
  thicknessIndex,
  onThicknessIndex,
  cropVariant,
  onCropVariant,
  open,
  onToggleOpen,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  hasCrop,
  cropPending,
  onConfirmCrop,
  onClearCrop,
  dirty,
  saving,
  onSave,
  saveTargets,
  onSaveAsNew,
}: Props) {
  // Viewport coordinates, not a boolean: the tool group is `overflow: hidden`
  // (it clips the segmented corners), so an absolutely-positioned menu inside
  // it renders and is then clipped to nothing. Anchoring from the button's
  // measured rect and rendering `position: fixed` escapes every clipping
  // ancestor.
  const [cropMenu, setCropMenu] = useState<{ x: number; y: number } | null>(null);
  const cropWrapRef = useRef<HTMLDivElement>(null);

  // Save overwrites the original screenshot with no undo and no Recycle Bin, so
  // it arms first — the same two-step the viewer's Delete and Clear all use.
  const [armSave, setArmSave] = useState(false);
  useEffect(() => {
    if (!armSave) return;
    const t = window.setTimeout(() => setArmSave(false), ARM_MS);
    return () => window.clearTimeout(t);
  }, [armSave]);
  // Nothing left to overwrite (saved, undone, or a different shot selected).
  useEffect(() => {
    if (!dirty) setArmSave(false);
  }, [dirty]);

  // Capture-phase, and dismissed by ref containment rather than
  // stopPropagation — a React handler cannot block a capture listener, which
  // is a documented trap in this codebase.
  useEffect(() => {
    if (!cropMenu) return;
    const onDown = (e: PointerEvent) => {
      if (cropWrapRef.current?.contains(e.target as Node)) return;
      setCropMenu(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [cropMenu]);

  if (!open) {
    return (
      <div
        style={{
          position: "relative",
          height: 22,
          flexShrink: 0,
          borderBottom: "1px solid var(--ezy-border-subtle)",
        }}
      >
        <CollapseChevron open={false} onClick={onToggleOpen} />
      </div>
    );
  }

  const visibleInks = inksExpanded ? inks : inks.slice(0, COLLAPSED_INKS);

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        // Right padding clears the absolutely-positioned collapse chevron so a
        // wide toolbar can never slide under it.
        padding: "8px 40px",
        borderBottom: "1px solid var(--ezy-border-subtle)",
        flexShrink: 0,
        flexWrap: "wrap",
      }}
    >
      {/* Tools */}
      <div
        style={{
          display: "flex",
          borderRadius: 5,
          overflow: "hidden",
          border: "1px solid var(--ezy-border)",
        }}
      >
        {TOOLS.map((t) => {
          const isCrop = t.id === "crop";
          return (
            <div
              key={t.id}
              ref={isCrop ? cropWrapRef : undefined}
              role="button"
              tabIndex={0}
              aria-pressed={tool === t.id}
              onClick={() => onTool(t.id)}
              onContextMenu={
                isCrop
                  ? (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const r = e.currentTarget.getBoundingClientRect();
                      setCropMenu((v) => (v ? null : { x: r.left, y: r.bottom + 6 }));
                    }
                  : undefined
              }
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  onTool(t.id);
                }
              }}
              data-tooltip={
                isCrop ? `${t.label} ${cropVariant.toUpperCase()} — right-click to switch` : t.label
              }
              data-tooltip-shortcut={t.key}
              style={{
                position: "relative",
                width: 30,
                height: 26,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                backgroundColor: tool === t.id ? "var(--ezy-accent)" : "transparent",
                color: tool === t.id ? "#fff" : "var(--ezy-text-secondary)",
                transition: "background-color 120ms ease, color 120ms ease",
              }}
              onMouseEnter={(e) => {
                if (tool !== t.id) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
              }}
              onMouseLeave={(e) => {
                if (tool !== t.id) e.currentTarget.style.backgroundColor = "transparent";
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                aria-hidden="true"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {t.icon}
              </svg>

              {/* Which crop is armed has to be visible without hovering —
                  the two behave differently enough to be surprising. */}
              {isCrop && cropVariant === "v2" && (
                <span
                  style={{
                    position: "absolute",
                    right: 2,
                    bottom: 1,
                    fontSize: 8,
                    fontWeight: 700,
                    lineHeight: 1,
                    color: tool === t.id ? "#fff" : "var(--ezy-text-muted)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  2
                </span>
              )}

              {isCrop && cropMenu && (
                <div
                  className="dropdown-enter"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: "fixed",
                    left: Math.min(cropMenu.x, window.innerWidth - 200),
                    top: cropMenu.y,
                    zIndex: 260,
                    minWidth: 190,
                    padding: "4px 0",
                    borderRadius: 6,
                    backgroundColor: "var(--ezy-surface-raised)",
                    border: "1px solid var(--ezy-border)",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                    cursor: "default",
                  }}
                >
                  {(
                    [
                      { id: "v1" as const, label: "Crop V1", hint: "Draw a region" },
                      { id: "v2" as const, label: "Crop V2", hint: "Drag dashed borders" },
                    ]
                  ).map((v) => (
                    <div
                      key={v.id}
                      onClick={() => {
                        onCropVariant(v.id);
                        onTool("crop");
                        setCropMenu(null);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 10px",
                        fontSize: 12,
                        color: "var(--ezy-text)",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = "transparent";
                      }}
                    >
                      <span
                        style={{
                          width: 10,
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          color: "var(--ezy-accent)",
                        }}
                      >
                        {cropVariant === v.id && (
                          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
                            <path
                              d="M2.5 6.2 L4.8 8.5 L9.5 3.5"
                              stroke="currentColor"
                              strokeWidth="1.6"
                              fill="none"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </span>
                      <span style={{ flex: 1 }}>{v.label}</span>
                      <span style={{ fontSize: 10, color: "var(--ezy-text-muted)" }}>{v.hint}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Divider />

      {/* Ink, most-recently-used first. Literal hexes: user content, not chrome. */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {visibleInks.map((ink) => {
          const active = ink.color.toLowerCase() === color.toLowerCase();
          return (
            <div
              key={ink.id}
              role="button"
              tabIndex={0}
              aria-pressed={active}
              onClick={() => onColor(ink.color)}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  onColor(ink.color);
                }
              }}
              data-tooltip={ink.label}
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                cursor: "pointer",
                backgroundColor: ink.color,
                flexShrink: 0,
                // Border width changes INSIDE the box, so selecting a swatch
                // never nudges its neighbours.
                border: active ? "2px solid #fff" : "1px solid rgba(0,0,0,0.35)",
                boxSizing: "border-box",
              }}
            />
          );
        })}

        {inks.length > COLLAPSED_INKS && (
          <div
            role="button"
            tabIndex={0}
            aria-expanded={inksExpanded}
            onClick={onToggleInks}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                onToggleInks();
              }
            }}
            data-tooltip={inksExpanded ? "Fewer colours" : "More colours"}
            style={{
              width: 14,
              height: 16,
              marginLeft: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: "var(--ezy-text-muted)",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--ezy-text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--ezy-text-muted)";
            }}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
              <path
                // The four most-used inks keep their position; the rest unfold
                // to the right of this chevron.
                d={inksExpanded ? "M7.5 2 L4 6 L7.5 10" : "M4.5 2 L8 6 L4.5 10"}
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        )}
      </div>

      <Divider />

      {/* Weight — the bars themselves are the label. */}
      <div
        style={{
          display: "flex",
          borderRadius: 5,
          overflow: "hidden",
          border: "1px solid var(--ezy-border)",
        }}
      >
        {THICKNESS_PRESETS.map((_, i) => {
          const active = i === thicknessIndex;
          // The width this step actually produces for the armed tool — a
          // highlighter's "medium" is far fatter than a rectangle's.
          const realWidth = resolveThickness(tool, i);
          return (
            <div
              key={i}
              role="button"
              tabIndex={0}
              aria-pressed={active}
              onClick={() => onThicknessIndex(i)}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  onThicknessIndex(i);
                }
              }}
              data-tooltip={`${realWidth} px`}
              style={{
                width: 28,
                height: 26,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                backgroundColor: active ? "var(--ezy-accent)" : "transparent",
                transition: "background-color 120ms ease",
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.backgroundColor = "transparent";
              }}
            >
              <div
                style={{
                  width: 16,
                  // Preview scaled per family so the four bars stay visually
                  // distinct whichever tool is armed.
                  height:
                    tool === "marker"
                      ? Math.min(10, Math.max(3, Math.round(realWidth / 5)))
                      : Math.min(8, Math.max(2, Math.round(realWidth / 1.6))),
                  borderRadius: 999,
                  backgroundColor: active ? "#fff" : "var(--ezy-text-secondary)",
                }}
              />
            </div>
          );
        })}
      </div>

      <Divider />

      {/* History */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <IconAction
          disabled={!canUndo}
          onClick={onUndo}
          tooltip="Undo"
          shortcut="Ctrl+Z"
          label="Undo"
        >
          <path d="M4 3 L1.5 5.5 L4 8" />
          <path d="M1.5 5.5 H7 A3 3 0 0 1 7 11.5 H5" />
        </IconAction>
        <IconAction
          disabled={!canRedo}
          onClick={onRedo}
          tooltip="Redo"
          shortcut="Ctrl+Shift+Z"
          label="Redo"
        >
          <path d="M8 3 L10.5 5.5 L8 8" />
          <path d="M10.5 5.5 H5 A3 3 0 0 0 5 11.5 H7" />
        </IconAction>
      </div>

      {(cropPending || hasCrop) && (
        <>
          <Divider />
          {cropPending && (
            <div
              role="button"
              tabIndex={0}
              onClick={onConfirmCrop}
              data-tooltip="Apply the crop — Ctrl+Z puts it back"
              style={{
                height: 26,
                padding: "0 12px",
                display: "flex",
                alignItems: "center",
                gap: 6,
                borderRadius: 5,
                border: "none",
                backgroundColor: "var(--ezy-accent)",
                color: "#fff",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                <path
                  d="M2.5 6.2 L4.8 8.5 L9.5 3.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Confirm crop
            </div>
          )}
          {hasCrop && (
            <div
              role="button"
              tabIndex={0}
              onClick={onClearCrop}
              data-tooltip="Restore the full image"
              style={{
                height: 26,
                padding: "0 10px",
                display: "flex",
                alignItems: "center",
                borderRadius: 5,
                border: "1px solid var(--ezy-border)",
                color: "var(--ezy-text-secondary)",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              Reset crop
            </div>
          )}
        </>
      )}

      <Divider />

      <div
        role="button"
        tabIndex={0}
        aria-disabled={!dirty || saving}
        onClick={() => {
          if (!dirty || saving) return;
          if (armSave) {
            setArmSave(false);
            onSave();
          } else {
            setArmSave(true);
          }
        }}
        data-tooltip={
          !dirty
            ? "Draw something first"
            : armSave
              ? "Click again to overwrite. There is no undo and nothing goes to the Recycle Bin."
              : "Overwrites this screenshot in Pictures\\Screenshots and in temp \u2014 the original is not kept"
        }
        style={{
          height: 26,
          padding: "0 12px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          borderRadius: 5,
          border: "none",
          backgroundColor: !dirty
            ? "var(--ezy-surface)"
            : armSave
              ? "var(--ezy-red, #dc2626)"
              : "var(--ezy-accent)",
          color: dirty ? "#fff" : "var(--ezy-text-muted)",
          fontSize: 11,
          fontWeight: 600,
          cursor: dirty && !saving ? "pointer" : "default",
          opacity: saving ? 0.6 : 1,
          transition: "background-color 120ms ease, color 120ms ease",
        }}
      >
        {!armSave && (
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 2 H8.5 L10 3.5 V10 H2 Z" />
            <path d="M4 2 V5 H8 V2" />
          </svg>
        )}
        {saving
          ? "Saving..."
          : armSave
            ? `Overwrite ${saveTargets} ${saveTargets === 1 ? "file" : "files"}?`
            : "Save"}
      </div>

      <div
        role="button"
        tabIndex={0}
        aria-disabled={!dirty || saving}
        onClick={() => {
          if (dirty && !saving) onSaveAsNew();
        }}
        data-tooltip={
          dirty
            ? "Write a new screenshot and leave the original untouched"
            : "Draw something first"
        }
        style={{
          height: 26,
          padding: "0 10px",
          display: "flex",
          alignItems: "center",
          borderRadius: 5,
          border: "1px solid var(--ezy-border)",
          backgroundColor: "transparent",
          color: dirty ? "var(--ezy-text-secondary)" : "var(--ezy-text-muted)",
          fontSize: 11,
          cursor: dirty && !saving ? "pointer" : "default",
          opacity: saving ? 0.6 : 1,
        }}
      >
        Save as new
      </div>

      <CollapseChevron open onClick={onToggleOpen} />
    </div>
  );
}

/**
 * Collapses the whole row. Absolutely positioned so it sits out of the flex
 * flow — otherwise it would count toward the centred group and push everything
 * a few pixels left of true centre.
 */
function CollapseChevron({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onClick();
        }
      }}
      data-tooltip={open ? "Hide the markup tools (M)" : "Show the markup tools (M)"}
      style={{
        position: "absolute",
        right: 10,
        top: "50%",
        transform: "translateY(-50%)",
        width: 22,
        height: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 4,
        cursor: "pointer",
        color: "var(--ezy-text-muted)",
        transition: "background-color 120ms ease, color 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
        e.currentTarget.style.color = "var(--ezy-text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
        e.currentTarget.style.color = "var(--ezy-text-muted)";
      }}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
        <path
          d={open ? "M2.5 7.5 L6 4 L9.5 7.5" : "M2.5 4.5 L6 8 L9.5 4.5"}
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{
        width: 1,
        height: 16,
        backgroundColor: "var(--ezy-border)",
        flexShrink: 0,
      }}
    />
  );
}

function IconAction({
  children,
  onClick,
  disabled,
  tooltip,
  shortcut,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tooltip: string;
  shortcut?: string;
  label: string;
}) {
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={label}
      onClick={() => {
        if (!disabled) onClick();
      }}
      onKeyDown={(e) => {
        if (!disabled && (e.key === " " || e.key === "Enter")) {
          e.preventDefault();
          onClick();
        }
      }}
      data-tooltip={tooltip}
      data-tooltip-shortcut={shortcut}
      style={{
        width: 26,
        height: 26,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 5,
        border: "1px solid var(--ezy-border)",
        color: "var(--ezy-text-secondary)",
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? "default" : "pointer",
        transition: "background-color 120ms ease",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden="true"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </div>
  );
}

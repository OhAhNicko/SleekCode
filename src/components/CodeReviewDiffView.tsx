import { useRef, useCallback, useState } from "react";
import type { FileDiff, DiffHunk } from "../types";
import { statusBadge } from "./CodeReviewFileList";

interface CodeReviewDiffViewProps {
  fileDiffs: FileDiff[];
  selectedFile: string | null;
  onRevertHunk: (fileDiff: FileDiff, hunkIndex: number) => void;
  onDiscardFile: (filePath: string, isUntracked: boolean) => void;
  onOpenInEditor: (filePath: string) => void;
  isGitRepo: boolean;
  loading: boolean;
  error: string | null;
}

export default function CodeReviewDiffView({
  fileDiffs,
  selectedFile,
  onRevertHunk,
  onDiscardFile,
  onOpenInEditor,
  isGitRepo,
  loading,
  error,
}: CodeReviewDiffViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [hoveredHunk, setHoveredHunk] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);

  // Scroll to selected file
  const setFileRef = useCallback(
    (path: string) => (el: HTMLDivElement | null) => {
      fileRefs.current[path] = el;
      if (el && selectedFile === path) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [selectedFile]
  );

  // Empty states
  if (!isGitRepo) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: "var(--ezy-text-muted)" }}>
        <div className="text-center">
          <svg width="32" height="32" viewBox="0 0 16 16" fill="none" className="mx-auto mb-2 opacity-40">
            <path d="M8 1C4.13 1 1 4.13 1 8s3.13 7 7 7 7-3.13 7-7S11.87 1 8 1zm0 12c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z" fill="currentColor"/>
            <circle cx="8" cy="8" r="1.5" fill="currentColor"/>
          </svg>
          <div className="text-[12px]">Not a git repository</div>
          <div className="text-[11px] mt-1 opacity-60">Open a folder with a git repo to see changes</div>
        </div>
      </div>
    );
  }

  if (loading && fileDiffs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: "var(--ezy-text-muted)" }}>
        <div className="text-[12px]">Loading changes...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: "var(--ezy-red)" }}>
        <div className="text-center">
          <div className="text-[12px]">Error loading diff</div>
          <div className="text-[11px] mt-1 opacity-70">{error}</div>
        </div>
      </div>
    );
  }

  if (fileDiffs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ color: "var(--ezy-text-muted)" }}>
        <div className="text-center">
          <svg width="32" height="32" viewBox="0 0 16 16" fill="none" className="mx-auto mb-2 opacity-40">
            <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" fill="currentColor"/>
          </svg>
          <div className="text-[12px]">No changes</div>
          <div className="text-[11px] mt-1 opacity-60">Working tree is clean</div>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto">
      {fileDiffs.map((fileDiff) => (
        <div
          key={fileDiff.filePath}
          ref={setFileRef(fileDiff.filePath)}
          className="mb-1"
        >
          {/* File header — sticky */}
          <div
            className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5"
            style={{
              backgroundColor: "var(--ezy-surface-raised)",
              borderBottom: "1px solid var(--ezy-border-subtle)",
            }}
          >
            {statusBadge(fileDiff.status)}
            <span
              className="text-[11px] font-medium flex-1 truncate"
              style={{ color: "var(--ezy-text)", fontFamily: "var(--ezy-font-mono, monospace)" }}
            >
              {fileDiff.filePath}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => onOpenInEditor(fileDiff.filePath)}
                className="px-1.5 py-0.5 rounded text-[10px] hover:opacity-80 transition-opacity"
                style={{
                  color: "var(--ezy-text-secondary)",
                  border: "1px solid var(--ezy-border-subtle)",
                }}
                title="Open in editor"
              >
                Edit
              </button>
              {confirmDiscard === fileDiff.filePath ? (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => {
                      onDiscardFile(fileDiff.filePath, fileDiff.status === "??");
                      setConfirmDiscard(null);
                    }}
                    className="px-1.5 py-0.5 rounded text-[10px] bg-red-600 text-white hover:bg-red-700 transition-colors"
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => setConfirmDiscard(null)}
                    className="px-1.5 py-0.5 rounded text-[10px] hover:opacity-80"
                    style={{ color: "var(--ezy-text-muted)" }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDiscard(fileDiff.filePath)}
                  className="px-1.5 py-0.5 rounded text-[10px] hover:opacity-80 transition-opacity"
                  style={{
                    color: "var(--ezy-text-muted)",
                    border: "1px solid var(--ezy-border-subtle)",
                  }}
                  title="Discard all changes in this file"
                >
                  Discard
                </button>
              )}
            </div>
          </div>

          {/* Hunks */}
          {fileDiff.hunks.length === 0 ? (
            <div
              className="px-4 py-2 text-[11px]"
              style={{ color: "var(--ezy-text-muted)" }}
            >
              Binary file or no diff available
            </div>
          ) : (
            fileDiff.hunks.map((hunk, hunkIdx) => (
              <HunkBlock
                key={`${fileDiff.filePath}-${hunkIdx}`}
                hunk={hunk}
                hunkId={`${fileDiff.filePath}-${hunkIdx}`}
                isHovered={hoveredHunk === `${fileDiff.filePath}-${hunkIdx}`}
                onMouseEnter={() => setHoveredHunk(`${fileDiff.filePath}-${hunkIdx}`)}
                onMouseLeave={() => setHoveredHunk(null)}
                onRevert={() => onRevertHunk(fileDiff, hunkIdx)}
              />
            ))
          )}
        </div>
      ))}
    </div>
  );
}

interface HunkBlockProps {
  hunk: DiffHunk;
  hunkId: string;
  isHovered: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onRevert: () => void;
}

function HunkBlock({
  hunk,
  isHovered,
  onMouseEnter,
  onMouseLeave,
  onRevert,
}: HunkBlockProps) {
  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ fontFamily: "var(--ezy-font-mono, monospace)" }}
    >
      {/* Hunk header */}
      <div
        className="flex items-center px-3 py-0.5 text-[11px] relative"
        style={{
          backgroundColor: "var(--ezy-surface-raised)",
          color: "var(--ezy-text-muted)",
        }}
      >
        <span className="flex-1 truncate">{hunk.header}</span>
        {isHovered && (
          <button
            onClick={onRevert}
            className="px-1.5 py-0.5 rounded text-[10px] bg-red-600 text-white hover:bg-red-700 transition-colors shrink-0"
            title="Revert this hunk"
          >
            Revert
          </button>
        )}
      </div>

      {/* Lines */}
      <div className="text-[12px] leading-[18px]">
        {hunk.lines.map((line, lineIdx) => {
          let bgColor = "transparent";
          let gutterPrefix = " ";

          if (line.type === "add") {
            bgColor = "rgba(63, 185, 80, 0.12)";
            gutterPrefix = "+";
          } else if (line.type === "remove") {
            bgColor = "rgba(248, 81, 73, 0.12)";
            gutterPrefix = "-";
          }

          return (
            <div
              key={lineIdx}
              className="flex"
              style={{ backgroundColor: bgColor }}
            >
              {/* Old line number */}
              <span
                className="shrink-0 text-right px-1 select-none"
                style={{
                  width: 44,
                  minWidth: 44,
                  color: "var(--ezy-text-muted)",
                  fontSize: 11,
                  opacity: 0.6,
                }}
              >
                {line.type !== "add" ? line.oldLineNumber : ""}
              </span>
              {/* New line number */}
              <span
                className="shrink-0 text-right px-1 select-none"
                style={{
                  width: 44,
                  minWidth: 44,
                  color: "var(--ezy-text-muted)",
                  fontSize: 11,
                  opacity: 0.6,
                }}
              >
                {line.type !== "remove" ? line.newLineNumber : ""}
              </span>
              {/* Prefix (+/-/space) */}
              <span
                className="shrink-0 select-none"
                style={{
                  width: 16,
                  minWidth: 16,
                  textAlign: "center",
                  color:
                    line.type === "add"
                      ? "rgb(63, 185, 80)"
                      : line.type === "remove"
                        ? "rgb(248, 81, 73)"
                        : "var(--ezy-text-muted)",
                }}
              >
                {gutterPrefix}
              </span>
              {/* Content */}
              <span
                className="flex-1 pr-2 whitespace-pre"
                style={{
                  color: "var(--ezy-text)",
                  tabSize: 4,
                }}
              >
                {line.content}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

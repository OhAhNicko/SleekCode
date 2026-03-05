import type { GitFileStatus } from "../types";

interface CodeReviewFileListProps {
  files: GitFileStatus[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

function statusBadge(status: string) {
  let bg = "bg-neutral-600";
  let label = status;

  if (status === "M") bg = "bg-neutral-600";
  else if (status === "A") bg = "bg-emerald-600";
  else if (status === "D") bg = "bg-red-600";
  else if (status === "??") { bg = "bg-neutral-500"; label = "U"; }
  else if (status.startsWith("R")) { bg = "bg-cyan-600"; label = "R"; }

  return (
    <span
      className={`${bg} text-white text-[10px] font-semibold leading-none rounded px-1 py-[2px] inline-flex items-center justify-center`}
      style={{ minWidth: 18, textAlign: "center" }}
    >
      {label}
    </span>
  );
}

export { statusBadge };

export default function CodeReviewFileList({
  files,
  selectedFile,
  onSelectFile,
  collapsed,
  onToggleCollapse,
}: CodeReviewFileListProps) {
  if (collapsed) {
    return (
      <div
        className="flex flex-col items-center py-2"
        style={{
          width: 28,
          minWidth: 28,
          backgroundColor: "var(--ezy-surface)",
          borderRight: "1px solid var(--ezy-border-subtle)",
        }}
      >
        <button
          onClick={onToggleCollapse}
          className="p-1 rounded hover:opacity-80"
          style={{ color: "var(--ezy-text-muted)" }}
          title="Expand file list"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span
          className="text-[10px] mt-2"
          style={{ color: "var(--ezy-text-muted)", writingMode: "vertical-lr" }}
        >
          {files.length} files
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col"
      style={{
        width: 220,
        minWidth: 220,
        backgroundColor: "var(--ezy-surface)",
        borderRight: "1px solid var(--ezy-border-subtle)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-2 shrink-0"
        style={{
          height: 28,
          borderBottom: "1px solid var(--ezy-border-subtle)",
          color: "var(--ezy-text-secondary)",
        }}
      >
        <span className="text-[11px] font-medium">Changed Files</span>
        <button
          onClick={onToggleCollapse}
          className="p-0.5 rounded hover:opacity-80"
          style={{ color: "var(--ezy-text-muted)" }}
          title="Collapse file list"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {files.length === 0 ? (
          <div
            className="px-3 py-4 text-[11px] text-center"
            style={{ color: "var(--ezy-text-muted)" }}
          >
            No changed files
          </div>
        ) : (
          files.map((file) => {
            const isSelected = selectedFile === file.path;
            const fileName = file.path.split("/").pop() || file.path;
            const dirPath = file.path.includes("/")
              ? file.path.substring(0, file.path.lastIndexOf("/"))
              : "";

            return (
              <button
                key={file.path}
                onClick={() => onSelectFile(file.path)}
                className="w-full text-left px-2 py-1 flex items-center gap-1.5 hover:opacity-90 transition-colors"
                style={{
                  backgroundColor: isSelected
                    ? "var(--ezy-surface-raised)"
                    : "transparent",
                  color: "var(--ezy-text)",
                }}
              >
                {statusBadge(file.status)}
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] truncate">{fileName}</div>
                  {dirPath && (
                    <div
                      className="text-[10px] truncate"
                      style={{ color: "var(--ezy-text-muted)" }}
                    >
                      {dirPath}
                    </div>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Summary */}
      <div
        className="px-2 py-1.5 text-[10px] shrink-0"
        style={{
          borderTop: "1px solid var(--ezy-border-subtle)",
          color: "var(--ezy-text-muted)",
        }}
      >
        {files.length} file{files.length !== 1 ? "s" : ""} changed
      </div>
    </div>
  );
}

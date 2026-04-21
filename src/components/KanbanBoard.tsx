import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useAppStore } from "../store";
import type { TaskCard as TaskCardType } from "../types";
import TaskCard from "./TaskCard";
import PaneSearchBar from "./PaneSearchBar";
import { registerPaneSearch, unregisterPaneSearch } from "../lib/pane-search-registry";

const COLUMNS: { key: TaskCardType["status"]; label: string }[] = [
  { key: "todo", label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "done", label: "Done" },
];

interface KanbanBoardProps {
  onClose?: () => void;
  initialVertical?: boolean;
  onReposition?: (vertical: boolean) => void;
  paneId?: string;
}

function escapeRegExpKanban(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default function KanbanBoard({ onClose, initialVertical = false, onReposition, paneId }: KanbanBoardProps) {
  const tasks = useAppStore((s) => s.tasks);
  const addTask = useAppStore((s) => s.addTask);
  const moveTask = useAppStore((s) => s.moveTask);
  const removeTask = useAppStore((s) => s.removeTask);

  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [dragOverCol, setDragOverCol] = useState<TaskCardType["status"] | null>(null);
  const [vertical, setVertical] = useState(initialVertical);
  const dragItemId = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Per-pane search state.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCase, setSearchCase] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchWhole, setSearchWhole] = useState(false);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (!paneId) return;
    registerPaneSearch(paneId, () => setSearchOpen(true));
    return () => unregisterPaneSearch(paneId);
  }, [paneId]);

  const searchRegexp = useMemo<RegExp | null>(() => {
    if (!searchQuery) return null;
    try {
      const flags = searchCase ? "" : "i";
      if (searchRegex) {
        return new RegExp(
          searchWhole ? `\\b(?:${searchQuery})\\b` : searchQuery,
          flags,
        );
      }
      const escaped = escapeRegExpKanban(searchQuery);
      return new RegExp(
        searchWhole ? `\\b${escaped}\\b` : escaped,
        flags,
      );
    } catch {
      return null;
    }
  }, [searchQuery, searchCase, searchRegex, searchWhole]);

  const taskMatches = useCallback(
    (t: TaskCardType): boolean => {
      if (!searchRegexp) return true;
      if (searchRegexp.test(t.title)) return true;
      if (t.description && searchRegexp.test(t.description)) return true;
      return false;
    },
    [searchRegexp],
  );

  // Ordered list of matching task ids (traversal: columns left→right, by order).
  const matchingTaskIds = useMemo(() => {
    if (!searchQuery) return [] as string[];
    const out: string[] = [];
    for (const col of COLUMNS) {
      const rows = tasks
        .filter((t) => t.status === col.key)
        .sort((a, b) => a.order - b.order);
      for (const t of rows) {
        if (taskMatches(t)) out.push(t.id);
      }
    }
    return out;
  }, [tasks, searchQuery, taskMatches]);

  // Clamp / reset the active match index whenever the match set changes.
  useEffect(() => {
    if (matchingTaskIds.length === 0) {
      setActiveMatchIdx(0);
      return;
    }
    setActiveMatchIdx((idx) => (idx >= matchingTaskIds.length ? 0 : idx));
  }, [matchingTaskIds]);

  // Scroll the currently active match into view.
  useEffect(() => {
    if (!searchQuery || matchingTaskIds.length === 0) return;
    const id = matchingTaskIds[activeMatchIdx];
    const el = cardRefs.current[id];
    if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeMatchIdx, matchingTaskIds, searchQuery]);

  const handleSearchNext = useCallback(() => {
    if (matchingTaskIds.length === 0) return;
    setActiveMatchIdx((idx) => (idx + 1) % matchingTaskIds.length);
  }, [matchingTaskIds]);

  const handleSearchPrev = useCallback(() => {
    if (matchingTaskIds.length === 0) return;
    setActiveMatchIdx((idx) => (idx - 1 + matchingTaskIds.length) % matchingTaskIds.length);
  }, [matchingTaskIds]);

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setActiveMatchIdx(0);
  }, []);

  const matchInfo = searchQuery
    ? { index: activeMatchIdx, count: matchingTaskIds.length }
    : null;

  const handleAdd = useCallback(() => {
    const title = newTitle.trim();
    if (!title) return;
    addTask(title, newDesc.trim() || undefined);
    setNewTitle("");
    setNewDesc("");
    setShowForm(false);
  }, [newTitle, newDesc, addTask]);

  const handleRunTask = useCallback(
    (taskId: string) => {
      moveTask(taskId, "in_progress");
    },
    [moveTask]
  );

  const handleDragStart = useCallback((e: React.DragEvent, taskId: string) => {
    dragItemId.current = taskId;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", taskId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, col: TaskCardType["status"]) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverCol(col);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverCol(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, col: TaskCardType["status"]) => {
      e.preventDefault();
      setDragOverCol(null);
      const taskId = dragItemId.current;
      if (taskId) {
        moveTask(taskId, col);
        dragItemId.current = null;
      }
    },
    [moveTask]
  );

  const getColumnTasks = (status: TaskCardType["status"]) =>
    tasks.filter((t) => t.status === status).sort((a, b) => a.order - b.order);

  const columnAccentColor = (key: TaskCardType["status"]) => {
    switch (key) {
      case "todo":
        return "var(--ezy-text-muted)";
      case "in_progress":
        return "var(--ezy-cyan)";
      case "done":
        return "var(--ezy-accent)";
    }
  };

  return (
    <div
      className="h-full w-full flex flex-col relative"
      data-pane-id={paneId}
      style={{ backgroundColor: "var(--ezy-bg)", overflow: "hidden" }}
    >
      {searchOpen && (
        <PaneSearchBar
          query={searchQuery}
          setQuery={setSearchQuery}
          caseSensitive={searchCase}
          setCaseSensitive={setSearchCase}
          regex={searchRegex}
          setRegex={setSearchRegex}
          wholeWord={searchWhole}
          setWholeWord={setSearchWhole}
          matchInfo={matchInfo}
          onNext={handleSearchNext}
          onPrev={handleSearchPrev}
          onClose={handleSearchClose}
          isActive={true}
        />
      )}
      {/* Header */}
      <div
        className="flex items-center justify-between select-none"
        style={{
          height: 36,
          minHeight: 36,
          padding: "0 8px",
          borderBottom: "1px solid var(--ezy-border)",
          backgroundColor: "var(--ezy-surface)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--ezy-text-muted)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          Task Board
        </span>
        <div className="flex items-center gap-1">
          {/* Layout toggle */}
          <button
            onClick={() => {
              const next = !vertical;
              if (onReposition) {
                onReposition(next);
              } else {
                setVertical(next);
              }
            }}
            title={vertical ? "Horizontal layout" : "Vertical layout"}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              backgroundColor: "transparent",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
          >
            {vertical ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3">
                <rect x="1" y="2" width="14" height="12" rx="1" />
                <line x1="6" y1="2" x2="6" y2="14" />
                <line x1="11" y1="2" x2="11" y2="14" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="1.3">
                <rect x="1" y="2" width="14" height="12" rx="1" />
                <line x1="1" y1="6" x2="15" y2="6" />
                <line x1="1" y1="10" x2="15" y2="10" />
              </svg>
            )}
          </button>
          {/* Add Task */}
          <button
            onClick={() => {
              setShowForm(true);
              setTimeout(() => inputRef.current?.focus(), 50);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 10px",
              backgroundColor: "var(--ezy-accent-dim)",
              color: "var(--ezy-text)",
              border: "none",
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-accent-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--ezy-accent-dim)")}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="8" y1="3" x2="8" y2="13" />
              <line x1="3" y1="8" x2="13" y2="8" />
            </svg>
            Add Task
          </button>
          {/* Close (pane mode only) */}
          {onClose && (
            <button
              onClick={onClose}
              title="Close"
              className="group"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                backgroundColor: "transparent",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                marginLeft: 2,
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="var(--ezy-text-muted)"
                strokeWidth="1.5"
                strokeLinecap="round"
                className="group-hover:stroke-[var(--ezy-red)]"
              >
                <line x1="4" y1="4" x2="12" y2="12" />
                <line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Add Task form */}
      {showForm && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            flexShrink: 0,
          }}
        >
          <div className="flex gap-2" style={{ marginBottom: 6 }}>
            <input
              ref={inputRef}
              type="text"
              placeholder="Task title..."
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
                if (e.key === "Escape") setShowForm(false);
              }}
              style={{
                flex: 1,
                padding: "6px 8px",
                backgroundColor: "var(--ezy-bg)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 4,
                color: "var(--ezy-text)",
                fontSize: 12,
                outline: "none",
                fontFamily: "inherit",
              }}
            />
          </div>
          <div className="flex gap-2 items-center">
            <input
              type="text"
              placeholder="Description (optional)"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
                if (e.key === "Escape") setShowForm(false);
              }}
              style={{
                flex: 1,
                padding: "6px 8px",
                backgroundColor: "var(--ezy-bg)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 4,
                color: "var(--ezy-text)",
                fontSize: 12,
                outline: "none",
                fontFamily: "inherit",
              }}
            />
            <button
              onClick={handleAdd}
              style={{
                padding: "6px 12px",
                backgroundColor: "var(--ezy-accent)",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Add
            </button>
            <button
              onClick={() => {
                setShowForm(false);
                setNewTitle("");
                setNewDesc("");
              }}
              style={{
                padding: "6px 10px",
                backgroundColor: "transparent",
                color: "var(--ezy-text-muted)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 4,
                fontSize: 12,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Columns */}
      <div
        className={vertical ? "flex flex-col flex-1 min-h-0" : "flex flex-1 min-h-0"}
        style={{ padding: "12px 12px", gap: 12, overflow: "hidden" }}
      >
        {COLUMNS.map((col) => {
          const colTasks = getColumnTasks(col.key);
          const isDragOver = dragOverCol === col.key;

          return (
            <div
              key={col.key}
              className={vertical ? "flex flex-col flex-1 min-h-0" : "flex flex-col flex-1 min-w-0"}
              style={{
                backgroundColor: "var(--ezy-surface)",
                borderRadius: 8,
                border: `1px solid ${isDragOver ? columnAccentColor(col.key) : "var(--ezy-border)"}`,
                transition: "border-color 150ms ease",
                overflow: "hidden",
              }}
              onDragOver={(e) => handleDragOver(e, col.key)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, col.key)}
            >
              {/* Column header */}
              <div
                className="flex items-center justify-between select-none"
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--ezy-border)",
                  flexShrink: 0,
                }}
              >
                <div className="flex items-center gap-2">
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      backgroundColor: columnAccentColor(col.key),
                    }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--ezy-text)",
                      letterSpacing: "0.02em",
                    }}
                  >
                    {col.label}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--ezy-text-muted)",
                    fontWeight: 500,
                  }}
                >
                  {colTasks.length}
                </span>
              </div>

              {/* Cards */}
              <div
                className="flex flex-col gap-2"
                style={{
                  padding: 8,
                  flex: 1,
                  overflowY: "auto",
                  minHeight: 0,
                }}
              >
                {colTasks.map((task) => {
                  const matches = !searchQuery || taskMatches(task);
                  const isActiveMatch =
                    !!searchQuery &&
                    matchingTaskIds.length > 0 &&
                    matchingTaskIds[activeMatchIdx] === task.id;
                  return (
                    <div
                      key={task.id}
                      ref={(el) => {
                        cardRefs.current[task.id] = el;
                      }}
                      style={{
                        opacity: matches ? 1 : 0.2,
                        pointerEvents: matches ? "auto" : "none",
                        outline: isActiveMatch ? "2px solid var(--ezy-accent)" : "none",
                        outlineOffset: isActiveMatch ? 2 : 0,
                        borderRadius: 6,
                        transition: "opacity 120ms ease",
                      }}
                    >
                      <TaskCard
                        task={task}
                        onRun={task.status === "todo" ? () => handleRunTask(task.id) : undefined}
                        onRemove={() => removeTask(task.id)}
                        onDragStart={(e) => handleDragStart(e, task.id)}
                      />
                    </div>
                  );
                })}

                {colTasks.length === 0 && (
                  <div
                    style={{
                      padding: "16px 8px",
                      textAlign: "center",
                      fontSize: 11,
                      color: "var(--ezy-text-muted)",
                      opacity: 0.6,
                    }}
                  >
                    {col.key === "todo"
                      ? "No tasks yet"
                      : col.key === "in_progress"
                      ? "Drag tasks here"
                      : "Completed tasks"}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

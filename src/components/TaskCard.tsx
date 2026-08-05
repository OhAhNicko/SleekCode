import type { TaskCard as TaskCardType } from "../types";

interface TaskCardProps {
  task: TaskCardType;
  onRun?: () => void;
  onRemove: () => void;
  onDragStart: (e: React.DragEvent) => void;
}

export default function TaskCard({ task, onRun, onRemove, onDragStart }: TaskCardProps) {
  return (
    <div
      data-ctx-surface="kanban-card"
      data-ctx-id={task.id}
      data-ctx-label={task.title}
      draggable
      onDragStart={onDragStart}
      style={{
        padding: "8px 10px",
        backgroundColor: "var(--ezy-surface)",
        border: "1px solid var(--ezy-border)",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
        cursor: "grab",
        transition: "border-color 150ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--ezy-accent)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--ezy-border)";
      }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: task.description ? 4 : 0 }}>
        <span
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
            fontWeight: 500,
            color: "var(--ezy-text)",
          }}
        >
          {task.title}
        </span>
        <div className="flex items-center gap-1">
          {task.status === "todo" && onRun && (
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="var(--ezy-accent)"
              style={{ cursor: "pointer", flexShrink: 0 }}
              onClick={(e) => {
                e.stopPropagation();
                onRun();
              }}
            >
              <path d="M4 2l10 6-10 6V2z" />
            </svg>
          )}
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.5"
            strokeLinecap="round"
            style={{ cursor: "pointer", flexShrink: 0, opacity: 0.6 }}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <line x1="4" y1="4" x2="12" y2="12" />
            <line x1="12" y1="4" x2="4" y2="12" />
          </svg>
        </div>
      </div>
      {task.description && (
        <p
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-text-muted)",
            margin: 0,
            lineHeight: 1.4,
          }}
        >
          {task.description}
        </p>
      )}
      {task.agentType && (
        <span
          style={{
            display: "inline-block",
            marginTop: 4,
            fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
            fontWeight: 600,
            padding: "1px 5px",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
            backgroundColor: "var(--ezy-border)",
            color: "var(--ezy-text-muted)",
            textTransform: "uppercase",
          }}
        >
          {task.agentType}
        </span>
      )}
    </div>
  );
}

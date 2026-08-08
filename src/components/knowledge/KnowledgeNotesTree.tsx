import type { CSSProperties, ReactNode } from "react";
import {
  actorColor,
  actorLabel,
  NOTE_TYPE_LABEL,
  type KnowledgeActor,
  type KnowledgeNoteMeta,
  type KnowledgeNoteType,
  type KnowledgeSearchResult,
} from "../../lib/knowledge/types";

/**
 * The free-form notes list, plus the row primitive the whole knowledge sidebar
 * is built from.
 *
 * `KnowledgeRow` lives here rather than in its own module because the core
 * memory section is the same row with a fixed set of seven — one anatomy, one
 * hover, one selection treatment, so the eye reads the sidebar as a single
 * list instead of two widgets that happen to sit above each other.
 *
 * The anatomy carries exactly one idea beyond the title: WHO last wrote this
 * and HOW MANY times it has changed. That pairing — a 6px agent-coloured dot
 * against a muted revision number — is the whole point of shared memory, so it
 * is the only decoration a row gets.
 */

export const SECTION_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 6,
  padding: "10px 10px 4px",
  fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ezy-text-muted)",
  userSelect: "none",
};

interface KnowledgeRowProps {
  entityId: string;
  label: string;
  filePath: string;
  slug: string;
  type: KnowledgeNoteType;
  revision: number;
  actor: KnowledgeActor | undefined;
  /** Core docs cannot be renamed or archived — the menu reads this attribute. */
  core?: boolean;
  conflicted?: boolean;
  selected: boolean;
  onSelect: (entityId: string) => void;
  onOpen: (entityId: string) => void;
}

export function KnowledgeRow({
  entityId,
  label,
  filePath,
  slug,
  type,
  revision,
  actor,
  core,
  conflicted,
  selected,
  onSelect,
  onOpen,
}: KnowledgeRowProps) {
  return (
    <div
      role="option"
      id={`knowledge-row-${entityId}`}
      aria-selected={selected}
      data-knowledge-row={entityId}
      data-ctx-surface="knowledge-note"
      data-ctx-id={entityId}
      data-ctx-label={label}
      data-ctx-path={filePath}
      data-ctx-slug={slug}
      data-ctx-type={type}
      data-ctx-rev={String(revision)}
      data-ctx-core={core ? "1" : "0"}
      // No path tooltip: it fired on every row the pointer crossed (user,
      // 2026-08-08). The path lives in the context menu's "Copy path" now.
      // Single click SELECTS AND OPENS — the FileExplorer convention, and the
      // user's stated expectation (2026-08-08): a click that only highlights
      // reads as "nothing happened". Double-click stays as a no-op alias so a
      // habitual double-click never mis-fires.
      onClick={() => {
        onSelect(entityId);
        onOpen(entityId);
      }}
      onDoubleClick={() => onOpen(entityId)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 26,
        padding: "0 10px",
        cursor: "pointer",
        backgroundColor: selected ? "var(--ezy-surface-raised)" : "transparent",
        transition: "background-color 90ms ease",
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.03)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {conflicted && (
        <span
          aria-label="Unresolved conflict"
          data-tooltip="Unresolved conflict"
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            backgroundColor: "var(--ezy-red)",
            flexShrink: 0,
          }}
        />
      )}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
          color: selected ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {/* Attribution dot: whose write produced the current revision. A 6px
          dot is an impossible hover target, so the tooltip lives on a padded
          invisible wrapper. */}
      <span
        data-tooltip={`Last written by ${actorLabel(actor)}`}
        style={{ display: "inline-flex", alignItems: "center", padding: 4, margin: -4 }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: actorColor(actor),
            flexShrink: 0,
          }}
        />
      </span>
      {/* "rev" holds one x-position; only the NUMBER right-aligns inside a
          three-digit reservation (`ch` + tabular figures = exact digit
          widths). Nothing in the row moves until a revision hits 4 digits. */}
      <span
        style={{
          fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
          color: "var(--ezy-text-muted)",
          flexShrink: 0,
          display: "inline-flex",
          gap: "0.35em",
        }}
      >
        rev
        <span
          style={{
            fontVariantNumeric: "tabular-nums",
            minWidth: "3ch",
            textAlign: "right",
          }}
        >
          {revision}
        </span>
      </span>
    </div>
  );
}

/**
 * Bold every occurrence of the query's terms in the snippet. Client-side on
 * purpose: the FTS snippet string also feeds agents through the MCP adapter,
 * so embedding highlight markers at the SQL level would leak control
 * characters into their context. Prefix matching keeps stemmed hits lit
 * ("pelicans" for a "pelican" query bolds the part the user typed).
 */
function highlightSnippet(snippet: string, query: string): React.ReactNode {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1);
  if (terms.length === 0) return snippet;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = snippet.split(re);
  if (parts.length === 1) return snippet;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} style={{ fontWeight: 600, color: "var(--ezy-text)" }}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/** A search hit: title above a single elided line of matching text. */
export function KnowledgeSearchRow({
  result,
  selected,
  onSelect,
  onOpen,
  query = "",
}: {
  result: KnowledgeSearchResult;
  selected: boolean;
  onSelect: (entityId: string) => void;
  onOpen: (entityId: string) => void;
  query?: string;
}) {
  return (
    <div
      role="option"
      id={`knowledge-row-${result.entityId}`}
      aria-selected={selected}
      data-knowledge-row={result.entityId}
      data-ctx-surface="knowledge-note"
      data-ctx-id={result.entityId}
      data-ctx-label={result.title}
      data-ctx-path={result.filePath}
      data-ctx-type={result.type}
      // Same single-click-opens contract as KnowledgeRow above.
      onClick={() => {
        onSelect(result.entityId);
        onOpen(result.entityId);
      }}
      onDoubleClick={() => onOpen(result.entityId)}
      style={{
        padding: "6px 10px",
        cursor: "pointer",
        backgroundColor: selected ? "var(--ezy-surface-raised)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.03)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      <div
        style={{
          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
          color: selected ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {/* Core docs are NAMED by their type, so the prefix would print the
            title twice ("State · State"). Only show it when it adds a fact. */}
        {NOTE_TYPE_LABEL[result.type] !== result.title && (
          <span style={{ color: "var(--ezy-text-muted)" }}>
            {NOTE_TYPE_LABEL[result.type]} ·{" "}
          </span>
        )}
        {result.title}
      </div>
      {result.snippet && (
        <div
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            marginTop: 1,
          }}
        >
          {highlightSnippet(result.snippet, query)}
        </div>
      )}
    </div>
  );
}

export function KnowledgeEmptyLine({ text }: { text: ReactNode }) {
  return (
    <div
      style={{
        padding: "6px 10px 10px",
        fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
        color: "var(--ezy-text-muted)",
      }}
    >
      {text}
    </div>
  );
}

interface NotesTreeProps {
  notes: KnowledgeNoteMeta[];
  selectedId: string | null;
  conflictedIds: ReadonlySet<string>;
  onSelect: (entityId: string) => void;
  onOpen: (entityId: string) => void;
  onNewNote: () => void;
  /** Set when new notes cannot be created right now — the reason is the tip. */
  newNoteBlocked: string | null;
}

export default function KnowledgeNotesTree({
  notes,
  selectedId,
  conflictedIds,
  onSelect,
  onOpen,
  onNewNote,
  newNoteBlocked,
}: NotesTreeProps) {
  return (
    <div>
      <div style={SECTION_HEADER_STYLE}>
        <span>Notes</span>
        {/* A bare svg, not a button: buttons inherit line-height 1.5 and would
            silently make this 10px header 24px tall. */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke={newNoteBlocked ? "var(--ezy-border-light)" : "var(--ezy-text-muted)"}
          strokeWidth="1.5"
          strokeLinecap="round"
          role="button"
          aria-label="New note"
          aria-disabled={!!newNoteBlocked}
          data-tooltip={newNoteBlocked ?? "New note"}
          style={{ cursor: newNoteBlocked ? "default" : "pointer", flexShrink: 0 }}
          onClick={() => {
            if (!newNoteBlocked) onNewNote();
          }}
        >
          <line x1="8" y1="3" x2="8" y2="13" />
          <line x1="3" y1="8" x2="13" y2="8" />
        </svg>
      </div>
      {notes.length === 0 ? (
        <KnowledgeEmptyLine text="No notes yet" />
      ) : (
        notes.map((note) => (
          <KnowledgeRow
            key={note.id}
            entityId={note.id}
            label={note.title}
            filePath={note.filePath}
            slug={note.slug}
            type={note.type}
            revision={note.revision}
            actor={note.updatedBy}
            conflicted={conflictedIds.has(note.id)}
            selected={selectedId === note.id}
            onSelect={onSelect}
            onOpen={onOpen}
          />
        ))
      )}
    </div>
  );
}

import { KnowledgeRow, KnowledgeEmptyLine, SECTION_HEADER_STYLE } from "./KnowledgeNotesTree";
import {
  CORE_NOTE_TYPES,
  NOTE_TYPE_LABEL,
  type KnowledgeNoteMeta,
} from "../../lib/knowledge/types";

/**
 * The seven core memory documents, always in spec order and always all seven.
 *
 * They are singletons with fixed paths, so the list never reorders and never
 * changes length — which is what lets someone learn where "Decisions" is and
 * then stop reading the labels. A doc the service has not reported yet renders
 * as a muted placeholder rather than disappearing, because a gap in a fixed
 * list reads as a bug.
 */
interface Props {
  notes: KnowledgeNoteMeta[];
  selectedId: string | null;
  conflictedIds: ReadonlySet<string>;
  onSelect: (entityId: string) => void;
  onOpen: (entityId: string) => void;
}

export default function KnowledgeCoreSection({
  notes,
  selectedId,
  conflictedIds,
  onSelect,
  onOpen,
}: Props) {
  const byType = new Map<string, KnowledgeNoteMeta>();
  for (const note of notes) {
    if (!byType.has(note.type)) byType.set(note.type, note);
  }
  const resolved = CORE_NOTE_TYPES.map((type) => ({ type, note: byType.get(type) }));
  const anyPresent = resolved.some((r) => r.note);

  return (
    <div>
      <div style={SECTION_HEADER_STYLE}>
        <span>Core memory</span>
      </div>
      {!anyPresent ? (
        <KnowledgeEmptyLine text="Core memory files not found" />
      ) : (
        resolved.map(({ type, note }) =>
          note ? (
            <KnowledgeRow
              key={type}
              entityId={note.id}
              label={NOTE_TYPE_LABEL[type]}
              filePath={note.filePath}
              slug={note.slug}
              type={type}
              revision={note.revision}
              actor={note.updatedBy}
              core
              conflicted={conflictedIds.has(note.id)}
              selected={selectedId === note.id}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          ) : (
            <div
              key={type}
              style={{
                display: "flex",
                alignItems: "center",
                height: 26,
                padding: "0 10px",
                fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
                color: "var(--ezy-text-muted)",
              }}
              data-tooltip="Not reported by the knowledge service yet"
            >
              {NOTE_TYPE_LABEL[type]}
            </div>
          ),
        )
      )}
    </div>
  );
}

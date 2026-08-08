import {
  AGENT_DOT_COLOR,
  KNOWLEDGE_CLI_LABEL,
  type KnowledgePresence,
} from "../../lib/knowledge/types";

/**
 * The bottom strip: what this project can do right now, and what needs a
 * decision.
 *
 * Deliberately status only — the handoff actions live one level up in
 * `KnowledgeHandoffActions`, because they act on a PANE rather than on this
 * project, and mixing them in here invited the reading that they applied to
 * whatever was selected above. Per-CLI MCP status lives one level up too, in
 * `KnowledgeAgentAccess`, which replaced this footer's chips: those rendered
 * from a store field nothing populated and permanently said "Unknown".
 */

interface Props {
  conflictCount: number;
  pendingApprovals: number;
  presence: KnowledgePresence[];
  onResolveConflicts: () => void;
}

export default function KnowledgeFooter({
  conflictCount,
  pendingApprovals,
  presence,
  onResolveConflicts,
}: Props) {
  const active = presence.filter((p) => p.status === "active");

  // With the per-CLI chips gone this strip has no unconditional content, and an
  // empty bordered band under the Agents section reads as a rendering bug.
  if (conflictCount === 0 && pendingApprovals === 0 && active.length === 0) return null;

  return (
    <div
      style={{
        borderTop: "1px solid var(--ezy-border-subtle)",
        padding: 6,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {conflictCount > 0 && (
        <div
          role="button"
          onClick={onResolveConflicts}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 2px",
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-text-secondary)",
            cursor: "pointer",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              backgroundColor: "var(--ezy-red)",
              flexShrink: 0,
            }}
          />
          <span style={{ flex: 1 }}>
            {conflictCount} {conflictCount === 1 ? "conflict" : "conflicts"}
          </span>
          <span style={{ color: "var(--ezy-accent)" }}>Resolve</span>
        </div>
      )}

      {pendingApprovals > 0 && (
        <div
          style={{
            padding: "3px 2px",
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-text-secondary)",
          }}
        >
          {pendingApprovals} write {pendingApprovals === 1 ? "request" : "requests"} awaiting
          approval
        </div>
      )}

      {active.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            padding: "0 2px",
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-text-muted)",
          }}
        >
          {active.map((p, i) => (
            <span
              key={`${p.agentKind}-${p.paneId ?? i}`}
              style={{ display: "flex", alignItems: "center", gap: 4 }}
            >
              <span
                aria-hidden
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  backgroundColor: AGENT_DOT_COLOR[p.agentKind],
                }}
              />
              {KNOWLEDGE_CLI_LABEL[p.agentKind]} · active
            </span>
          ))}
        </div>
      )}

    </div>
  );
}

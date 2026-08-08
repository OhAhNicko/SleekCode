/**
 * Jira project tabs.
 *
 * NexusMind is not OFFERED here — a Jira tab exists to work tickets, and
 * seeding a `.project-memory/` into the repo from that surface was decided
 * against (2026-08-07). Like the SSH panel, the tab stays visible and states
 * the limit rather than hiding: a feature that vanishes per-tab reads as
 * broken, not as not-applicable.
 *
 * This panel only renders for a repo WITHOUT existing knowledge. One that was
 * initialized from a normal project tab attaches exactly as anywhere else and
 * never sees this.
 */
export default function KnowledgeJiraPanel() {
  return (
    <div style={{ padding: "14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
          color: "var(--ezy-text)",
          lineHeight: 1.5,
        }}
      >
        NexusMind is not offered for Jira projects.
      </div>
      <div
        style={{
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          color: "var(--ezy-text-muted)",
          lineHeight: 1.5,
        }}
      >
        To use shared memory in this repository, open it as a regular project and initialize
        NexusMind there — an initialized project works in its Jira tab too.
      </div>
    </div>
  );
}

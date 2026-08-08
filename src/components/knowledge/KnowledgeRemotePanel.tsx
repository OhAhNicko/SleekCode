/**
 * SSH project tabs.
 *
 * The tab stays visible on remote projects on purpose: hiding the feature
 * would make it look like it does not exist rather than like it does not apply
 * here yet, and someone who set it up on a local project would wonder where it
 * went. So it states the limit and why.
 */
export default function KnowledgeRemotePanel() {
  return (
    <div style={{ padding: "14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          fontSize: "calc(var(--ezy-font-scale, 1) * 12px)",
          color: "var(--ezy-text)",
          lineHeight: 1.5,
        }}
      >
        Knowledge is local-only for now — SSH projects are not supported yet.
      </div>
      <div
        style={{
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          color: "var(--ezy-text-muted)",
          lineHeight: 1.5,
        }}
      >
        Shared memory is a database plus a watched folder on the machine that runs MADE. A remote
        project's files live on the server, where neither of those can reach them.
      </div>
    </div>
  );
}

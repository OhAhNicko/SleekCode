/**
 * This MADE instance can read the project's memory but not write it.
 *
 * The realistic cause is a dev build running beside the production app on the
 * same project: one process holds the single-writer lock, the other follows.
 * Reads, search and "insert into agent" all still work, so the banner explains
 * the state rather than blocking the panel — and every mutating control in the
 * sidebar carries the same reason on its own tooltip.
 */
export default function KnowledgeReadonlyBanner({ reason }: { reason?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        minHeight: 30,
        padding: "6px 10px",
        flexShrink: 0,
        backgroundColor: "var(--ezy-surface-raised)",
        borderBottom: "1px solid var(--ezy-border-subtle)",
        fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
        color: "var(--ezy-text-secondary)",
        lineHeight: 1.35,
      }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="var(--ezy-text-muted)"
        strokeWidth="1.4"
        strokeLinecap="round"
        style={{ flexShrink: 0 }}
      >
        <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
        <path d="M5.75 7V5a2.25 2.25 0 0 1 4.5 0v2" />
      </svg>
      <span>{reason || "Read-only — another MADE instance owns this knowledge."}</span>
    </div>
  );
}

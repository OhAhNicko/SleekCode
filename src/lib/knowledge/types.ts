/**
 * Shared types for NexusMind — the shared agent knowledge workspace.
 *
 * UI branding is "NexusMind"; the code namespace is `knowledge` throughout
 * (`knowledge_*` Tauri commands, `src/lib/knowledge/`, `src-tauri/src/knowledge/`).
 *
 * Everything here mirrors a shape the Rust Knowledge Service produces. The
 * frontend never writes a projection file itself and never derives a revision:
 * the service is the single writer, and every mutation carries the
 * `baseRevision` the UI was looking at so a stale edit becomes a conflict
 * rather than a silent overwrite.
 */

/** The CLIs that can hold a knowledge-writing agent session.
 *
 *  Deliberately NOT `JiraCli` — that union is Atlassian-specific and the two
 *  features must be free to diverge. */
export type KnowledgeCli = "claude" | "codex" | "gemini";

export const KNOWLEDGE_CLIS: readonly KnowledgeCli[] = ["claude", "codex", "gemini"];

export const KNOWLEDGE_CLI_LABEL: Record<KnowledgeCli, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
};

/**
 * Agent attribution colours. These are the dot colours already shipped in
 * Sidebar.tsx's terminal list and TerminalHeader — knowledge rows reuse them so
 * "the orange one is Claude" means the same thing everywhere in the app.
 */
export const AGENT_DOT_COLOR: Record<KnowledgeCli, string> = {
  claude: "#e87b35",
  codex: "#10b981",
  gemini: "#a78bfa",
};

/**
 * What the sidebar is showing right now. Each value routes to one panel, and
 * every mutating affordance reads this to decide its disabled reason.
 */
export type KnowledgeStatus =
  | "loading"
  | "uninitialized"
  | "ready"
  | "readonly"
  | "unavailable"
  | "remote-unsupported";

/** Per-project write policy for AGENT (MCP) writes. UI edits are never gated. */
export type KnowledgePolicy = "read-only" | "ask" | "trusted";

/**
 * The 7 core memory docs are singletons with fixed paths; everything else is a
 * free `note`. The service decides the type — the UI only groups by it.
 */
export type KnowledgeNoteType =
  | "project"
  | "state"
  | "architecture"
  | "decisions"
  | "learnings"
  | "tasks"
  | "handoffs"
  | "note";

/**
 * Who last wrote an entity. `agentKind` is present only for `agent`.
 *
 * The four kinds are genuinely four different answers, and collapsing any pair
 * would make the history lie:
 *
 *  - `user` — someone edited it in MADE.
 *  - `agent` — a CLI wrote it through the MCP tools, so we know WHICH one.
 *  - `external` — the markdown changed on disk and MADE cannot say by whom: an
 *    editor, a script, or a CLI writing the file directly instead of using the
 *    tools. Naming that honestly matters, because attributing it to an agent
 *    would put a name on a change nobody can vouch for.
 *  - `system` — MADE itself, e.g. a scaffold or an import.
 */
export interface KnowledgeActor {
  kind: "user" | "agent" | "external" | "system";
  agentKind?: KnowledgeCli;
}

export interface KnowledgeNoteMeta {
  id: string;
  type: KnowledgeNoteType;
  title: string;
  slug: string;
  tags: string[];
  revision: number;
  /** Epoch ms. ISO strings only ever exist at the frontmatter boundary. */
  updatedAt: number;
  updatedBy: KnowledgeActor;
  /** Absolute path of the markdown projection — what "Open" opens. */
  filePath: string;
  archived: boolean;
  /** Set when this entity has an unresolved service-level conflict. */
  conflictId?: string;
}

export interface KnowledgeLinkRef {
  /** Absent when the link target does not exist — a broken link stays visible. */
  id?: string;
  title: string;
  broken?: boolean;
}

export interface KnowledgeNoteDetail extends KnowledgeNoteMeta {
  backlinks: { id: string; title: string }[];
  outgoingLinks: KnowledgeLinkRef[];
  /** Body text without frontmatter, when the service supplies it. */
  content?: string;
}

export interface KnowledgeSearchResult {
  entityId: string;
  title: string;
  type: KnowledgeNoteType;
  /** FTS5 snippet() output — already elided by the service. */
  snippet: string;
  filePath: string;
}

export interface KnowledgeRevisionInfo {
  revision: number;
  actor: KnowledgeActor;
  createdAt: number;
  /** Why the revision was written, when the writer said. */
  reason?: string;
}

export interface KnowledgeRevisionSnapshot {
  revision: number;
  content: string;
  actor: KnowledgeActor;
  createdAt: number;
  reason?: string;
}

/** Summary row for the footer count and the modal's rail. */
export interface KnowledgeConflict {
  id: string;
  entityId: string;
  title: string;
  yoursActor: KnowledgeActor;
  currentActor: KnowledgeActor;
  createdAt: number;
  /** Where the losing write came from: an API/MCP call or a file edit. */
  source?: "api" | "file";
  /** The service MAY inline the three texts on the list row. When it does the
   *  modal opens without a second round-trip. */
  yours?: string;
  current?: string;
  merged?: string;
  /**
   * The note's LIVE head revision when this record was read — NOT the revision
   * the conflict was raised against.
   *
   * A conflict dialog is open for as long as someone takes to read two versions
   * of a document, and the note can move underneath them in that time. Sending
   * this back with the resolution lets the service refuse rather than commit a
   * decision made about text that is no longer current.
   *
   * Lives on the summary, not just the detail, because the modal populates
   * itself from an inlined list row whenever the service provides one — putting
   * it only on the detail would silently drop the guard on that path.
   */
  headRevision?: number;
}

export interface KnowledgeConflictDetail extends KnowledgeConflict {
  yours: string;
  current: string;
  /** Absent when the 3-way merge could not produce a clean result — the
   *  "Accept merged" action is then disabled WITH that reason. */
  merged?: string;
}

export type KnowledgeConflictResolution = "mine" | "theirs" | "merged";

/**
 * What came back from a resolve attempt.
 *
 * `stale` is not an error: the record is still open and the service has handed
 * back the current text, so the user re-decides against what the document
 * actually says now. Treating it as a failure would either close a conflict
 * that is still live or push a retry that commits the same outdated choice.
 */
export type KnowledgeConflictResolveResult =
  | { status: "resolved" }
  | {
      status: "stale";
      /** New live head to guard the next attempt with. */
      headRevision?: number;
      /** Current text as of that head, when the service returned it. */
      current?: string;
      /** Re-merged against the new head. Absent means no clean merge exists. */
      merged?: string;
    };

/** One entity that went into a resolved context package. */
export interface ContextSource {
  entityId: string;
  revision: number;
  title: string;
  filePath: string;
  content: string;
}

/** Spec §13. `renderedPromptContext` is the block appended to a prompt. */
export interface ContextPackage {
  projectId: string;
  generatedAt: number;
  knowledgeRevision: number;
  tokenEstimate: number;
  sources: ContextSource[];
  renderedPromptContext: string;
  /** True when the budget cut sources at a heading boundary. */
  truncated?: boolean;
}

export interface KnowledgeHandoff {
  id: string;
  entityId?: string;
  title: string;
  createdAt: number;
  createdBy: KnowledgeActor;
  /** HANDOFFS.md-shaped text — what "Continue from latest handoff" pastes. */
  renderedMarkdown: string;
  consumedAt?: number;
}

/** A live agent session the service knows about (spec 6.5). */
export interface KnowledgePresence {
  agentKind: KnowledgeCli;
  paneId?: string;
  status: "active" | "closed";
  lastSeenAt: number;
}

/**
 * 3-state MCP registration for one CLI. Identical contract to `JiraMcpStatus`:
 * `checked:false` means "could not read the config" and MUST render as
 * Unknown — telling someone to install what they already have is worse than
 * saying nothing.
 *
 * Not populated in this wave: the per-CLI configurator ships with the MCP
 * adapter. The footer renders the Unknown state until then.
 */
export interface KnowledgeMcpStatus {
  configured: boolean;
  scope: string;
  name: string;
  checked: boolean;
}

/** What `knowledge_status` / `knowledge_open` describe about one project. */
export interface KnowledgeProjectStatus {
  status: KnowledgeStatus;
  /** Why this instance is read-only — shown verbatim in the banner. */
  readonlyReason?: string;
  /** Global knowledge revision (the service's last event seq). */
  revision: number;
  noteCount: number;
  conflictCount: number;
  pendingApprovals: number;
  policy: KnowledgePolicy;
  presence: KnowledgePresence[];
  /** Absolute path of the `.project-memory` directory, when initialized. */
  memoryDir?: string;
  /** True when `.project-memory/` is already covered by .gitignore. */
  gitignored?: boolean;
}

/**
 * Payload of the single Tauri event `made:knowledge-changed`, coalesced
 * ~150ms in Rust. Deliberately tiny — the UI re-queries rather than receiving
 * entity bodies, so a burst of agent writes cannot flood the bridge.
 */
export interface KnowledgeChangedPayload {
  /** Rust-folded key. Must byte-match `canonicalProjectKey`. */
  projectKey: string;
  /** Raw path as the service knows it — the fallback match. */
  projectPath: string;
  revision: number;
  kinds: ("note" | "conflict" | "handoff" | "presence" | "approval" | "status")[];
  /** Capped at 32 by the service. */
  entityIds: string[];
  /** True when more entities changed than `entityIds` lists. */
  truncated?: boolean;
  openConflicts: number;
  /** Absent for system-originated changes. Drives own-edit toast suppression. */
  actor?: KnowledgeActor;
}

/** One row of the composer's prewarmed note index (Phase 5 consumes it). */
export interface NoteIndexEntry {
  entityId: string;
  slug: string;
  title: string;
  type: KnowledgeNoteType;
  revision: number;
}

/** Display label for a note type, used by search rows and the info panel. */
export const NOTE_TYPE_LABEL: Record<KnowledgeNoteType, string> = {
  project: "Project",
  state: "State",
  architecture: "Architecture",
  decisions: "Decisions",
  learnings: "Learnings",
  tasks: "Tasks",
  handoffs: "Handoffs",
  note: "Note",
};

/** The 7 core docs, in spec order. The sidebar renders exactly this list. */
export const CORE_NOTE_TYPES: readonly KnowledgeNoteType[] = [
  "project",
  "state",
  "architecture",
  "decisions",
  "learnings",
  "tasks",
  "handoffs",
];

/** Human label for an actor, e.g. "Codex" / "You" / "External" / "MADE". */
export function actorLabel(actor: KnowledgeActor | undefined): string {
  if (!actor) return "Unknown";
  if (actor.kind === "user") return "You";
  if (actor.kind === "system") return "MADE";
  // Before "external" existed this fell through to "Agent", which put a name on
  // an edit nobody can attribute. An off-tool disk write is exactly the change
  // a reader most needs told apart from one an agent claimed.
  if (actor.kind === "external") return "External";
  return actor.agentKind ? KNOWLEDGE_CLI_LABEL[actor.agentKind] : "Agent";
}

/** Dot colour for an actor — agent hues; you, MADE and external stay muted,
 *  because only a named agent has a colour that means anything. */
export function actorColor(actor: KnowledgeActor | undefined): string {
  if (actor?.kind === "agent" && actor.agentKind) return AGENT_DOT_COLOR[actor.agentKind];
  return "var(--ezy-text-muted)";
}

/**
 * The `@`-reference that names an entity in a prompt.
 *
 * Core docs have a stable one-word reference (`@state`); everything else is
 * addressed by slug. Defined once here because the sidebar's "Copy reference"
 * and the context menu's row build the same string from the same two fields,
 * and a second copy of this rule is a second thing to get wrong.
 */
export function knowledgeRefFor(type: KnowledgeNoteType, slug: string): string {
  return type === "note" ? `@note/${slug}` : `@${type}`;
}

import type { ContextPackage } from "./types";

/**
 * `@`-references: naming a piece of shared memory inside a prompt.
 *
 * The composer expands these at submit time, so a prompt that says
 * "continue using @state" reaches the CLI with the actual State document
 * appended. The reference set is deliberately tiny and stable — eight core
 * documents plus `@note/<slug>` — because a reference the user has to look up
 * is one they will not use.
 */

export interface CoreRef {
  /** The token without its leading "@". */
  name: string;
  /** What the popup shows on the left. */
  label: string;
  /** One line on the right. Says what gets pulled in, not what it is. */
  description: string;
}

/**
 * `@memory` is first and is the only aggregate: it stands for the whole core
 * set, which is what someone means by "read the project memory". The other
 * seven map one-to-one onto the core documents, in spec order.
 */
export const CORE_REFS: readonly CoreRef[] = [
  { name: "memory", label: "@memory", description: "All core memory documents" },
  { name: "project", label: "@project", description: "What this project is" },
  { name: "state", label: "@state", description: "Where the work stands now" },
  { name: "architecture", label: "@architecture", description: "How the system is built" },
  { name: "decisions", label: "@decisions", description: "Decisions and their reasons" },
  { name: "learnings", label: "@learnings", description: "What went wrong before" },
  { name: "tasks", label: "@tasks", description: "Open and completed tasks" },
  { name: "handoffs", label: "@handoffs", description: "Handoffs between agents" },
];

const CORE_NAMES = CORE_REFS.map((r) => r.name).join("|");

/**
 * Matches a complete reference in submitted text.
 *
 * Both ends are anchored on purpose. The left side requires start-of-string or
 * whitespace, so `user@host` and `foo@bar.com` are not references. The right
 * side is a lookahead for whitespace, end, or sentence punctuation, so
 * `@state.` at the end of a sentence still matches while `@statement` does not.
 *
 * **Case-insensitive**, and that is a correctness requirement rather than a
 * convenience. The composer's popup matches on a lowercased query, so typing
 * `@Memory` — or `@State` at the start of a sentence — shows the row, confirms
 * it, and auto-closes exactly as a valid reference does. A case-SENSITIVE
 * extraction then found nothing: no ref strip, no expansion, and not even the
 * "sent as typed" warning, because that path is gated on having found a
 * reference at all. The UI endorsed a token the resolver silently dropped.
 * `extractRefs` folds what it matches back to canonical form.
 *
 * Stateful (`g`), so callers must reset `lastIndex` or use `matchAll` — which
 * is why `extractRefs` below is the only intended consumer.
 */
export const REF_REGEX = new RegExp(
  `(^|\\s)@(${CORE_NAMES}|note\\/[A-Za-z0-9_-]+)(?=\\s|$|[.,;:!?])`,
  "gi",
);

/**
 * Every reference in `text`, in order, deduplicated, each WITH its leading "@".
 *
 * Returned in CANONICAL form, not as typed: core names are folded to lowercase,
 * which is the spelling Tab-completion inserts, the spelling the sidebar's Copy
 * reference produces, and the spelling the resolver understands — one
 * representation everywhere. Folding also collapses `@Memory` and `@memory` in
 * the same prompt into the single reference they obviously mean.
 *
 * A note slug keeps the case it was typed in, because that half addresses a
 * real file on disk rather than a fixed vocabulary.
 *
 * The user's own text is never rewritten — only what MADE resolves is
 * canonicalized.
 */
export function extractRefs(text: string): string[] {
  if (!text || !text.includes("@")) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(REF_REGEX)) {
    const raw = m[2];
    const lower = raw.toLowerCase();
    const ref = lower.startsWith("note/") ? `@note/${raw.slice("note/".length)}` : `@${lower}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/**
 * The `@` token the cursor is inside, or null.
 *
 * A faithful mirror of the composer's `findSlashToken`, with two consequences
 * worth stating because they are the whole safety story:
 *
 *  - it scans BACKWARD and stops at whitespace, so it works mid-sentence;
 *  - an "@" that is not preceded by whitespace or start-of-string returns null,
 *    which is what makes `user@host` and `me@example.com` inert.
 *
 * "/" is deliberately NOT a terminator here (unlike the slash version, where it
 * is): `@note/my-slug` is one token. The two are still mutually exclusive — a
 * token starts with either "/" or "@", never both.
 */
export function findAtToken(
  val: string,
  cursorPos: number,
): { query: string; start: number; end: number } | null {
  for (let i = cursorPos - 1; i >= 0; i--) {
    const ch = val[i];
    if (ch === " " || ch === "\n" || ch === "\t") return null;
    if (ch === "@") {
      if (i === 0 || /\s/.test(val[i - 1])) {
        return { query: val.slice(i + 1, cursorPos).toLowerCase(), start: i, end: cursorPos };
      }
      return null; // mid-word "@" — an email, an npm scope, a handle
    }
  }
  return null;
}

/**
 * True when a typed query could still become a reference.
 *
 * A "/" only ever belongs to `note/<slug>`, so a query containing one anywhere
 * else can never match. Checking it here rather than in `findAtToken` keeps
 * that function a faithful mirror of the slash original, and it is what closes
 * the popup the instant someone types `@tauri-apps/`.
 */
export function isRefQueryPlausible(query: string): boolean {
  const slash = query.indexOf("/");
  return slash === -1 || query.startsWith("note/");
}

/** "~1.4k tokens" / "~820 tokens" — a size, not a precise count. */
export function formatTokenEstimate(tokens: number): string {
  if (tokens < 1000) return `~${tokens} tokens`;
  return `~${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k tokens`;
}

// ── Preview handoff between the strip and submit() ──────────────────────────

/**
 * The last preview a composer resolved, per pane.
 *
 * The strip already asks the service what a prompt's references expand to, in
 * order to show a token count. Submitting a moment later would ask the exact
 * same question — so the answer is parked here and reused, which is what keeps
 * Enter instant on the common path instead of paying a round-trip the user can
 * feel.
 *
 * It is only ever reused when the refs AND the knowledge revision still match.
 * That bounds staleness rather than eliminating it, and the distinction is
 * worth stating: the check compares a revision this process knows about, so a
 * write it has not yet been told of cannot be detected. The honest guarantee is
 * that reused content is never staler than the preview the user was shown,
 * within PREVIEW_REUSE_MS plus however long a change takes to reach this store.
 * What IS guaranteed absolutely is the audit trail — `recordContext` logs the
 * revisions from the package that was sent, whatever their age.
 */
export interface RefPreviewEntry {
  at: number;
  refs: string[];
  /** Revision the BACKEND resolved this package at (`pkg.knowledgeRevision`). */
  revision: number;
  pkg: ContextPackage;
}

const previews = new Map<string, RefPreviewEntry>();

/** How stale a parked preview may be and still be reused on submit. */
export const PREVIEW_REUSE_MS = 5000;

export function publishRefPreview(terminalId: string, entry: RefPreviewEntry): void {
  if (!terminalId) return;
  previews.set(terminalId, entry);
}

export function clearRefPreview(terminalId: string): void {
  previews.delete(terminalId);
}

/**
 * The parked package regardless of age — for DISPLAY only.
 *
 * The preview dialog may show a package a few seconds old; what it must never
 * do is show one thing and send another, which is why sending goes through
 * `takeFreshRefPreview` and its revision check instead.
 */
export function peekRefPreview(terminalId: string): RefPreviewEntry | undefined {
  return previews.get(terminalId);
}

/**
 * A parked package that is still safe to send, or undefined.
 *
 * `revision` is the project's CURRENT knowledge revision at call time; passing
 * it in (rather than reading it here) keeps this module free of store imports.
 */
export function takeFreshRefPreview(
  terminalId: string,
  refs: string[],
  revision: number,
): ContextPackage | undefined {
  const hit = previews.get(terminalId);
  if (!hit) return undefined;
  if (Date.now() - hit.at > PREVIEW_REUSE_MS) return undefined;
  if (hit.revision !== revision) return undefined;
  if (hit.refs.length !== refs.length) return undefined;
  for (let i = 0; i < refs.length; i++) {
    if (hit.refs[i] !== refs[i]) return undefined;
  }
  return hit.pkg;
}

/**
 * "Something else already has this port" — recognised in dev-server output.
 *
 * Kept pure and separate from the picking logic (`dev-server-ports.ts`) because
 * the hard part here is not finding conflicts, it is NOT finding them: two of
 * the most common port lines a dev server prints are the framework announcing
 * it already solved the problem itself.
 *
 *   Vite : "Port 5173 is in use, trying another one..."
 *   Next : "⚠ Port 3000 is in use, trying 3001 instead."
 *
 * Treating either as a failure would ^C a server that was seconds from coming
 * up on its own fallback port, so every match is rejected when its line also
 * says "trying". The fatal spellings are the ones with no escape hatch — Vite's
 * `strictPort`, Angular, Node's raw EADDRINUSE, and the errno forms.
 */

export interface PortConflict {
  /**
   * The port the message names, or `null` when it names none — uvicorn's
   * "[Errno 98] Address already in use" and actix's "(os error 98)" both report
   * the failure without repeating the port. The caller knows which port it
   * launched on and substitutes that.
   */
  port: number | null;
}

/** The framework is handling it itself — not our problem, and not an error. */
const SELF_HEALING_RE = /\btrying\b/i;

/**
 * Fatal spellings, most specific first. The first pattern is the only one that
 * captures the port directly; the rest fall through to `portOnLine`.
 */
const CONFLICT_RES: RegExp[] = [
  // Vite (strictPort), Angular, Gatsby: "Port 6180 is already in use"
  /\bport\s+(\d{2,5})\s+is (?:already )?in use/i,
  // Node/libuv: "Error: listen EADDRINUSE: address already in use :::3000"
  /EADDRINUSE/i,
  // Python, Go, .NET, Docker: "…: address already in use", "bind: address already in use"
  /address already in use/i,
  // Rust/Python errno forms: "(os error 98)", "[Errno 48]", Windows "os error 10048"
  /\b(?:os error|errno)\s+(?:48|98|10048)\b/i,
];

/**
 * Last `:<port>` on a line — `:::3000` → 3000, and
 * "Failed to bind to address http://127.0.0.1:5000" → 5000 rather than any
 * earlier number. Anchored on digits immediately after the colon so
 * "EADDRINUSE: address already in use" cannot match its own colon.
 */
function portOnLine(line: string): number | null {
  const matches = line.match(/:(\d{2,5})\b/g);
  if (!matches) return null;
  const n = parseInt(matches[matches.length - 1].slice(1), 10);
  return n > 0 && n <= 65535 ? n : null;
}

/**
 * Scan ANSI-stripped dev-server output for a fatal port conflict.
 *
 * Line-based on purpose: a buffer can hold Vite's self-healing notice AND, later,
 * a real failure. Judging the whole blob at once would let either line veto the
 * other depending on which regex ran first.
 */
export function detectPortConflict(clean: string): PortConflict | null {
  for (const line of clean.split("\n")) {
    if (SELF_HEALING_RE.test(line)) continue;
    for (const re of CONFLICT_RES) {
      const m = line.match(re);
      if (!m) continue;
      const named = m[1] ? parseInt(m[1], 10) : NaN;
      if (named > 0 && named <= 65535) return { port: named };
      return { port: portOnLine(line) };
    }
  }
  return null;
}

/**
 * The ladder of ports to try, starting at `base` and stepping +1 — the same
 * pattern Vite and Next use when they move themselves, so 5173 → 5174 → 5175
 * and 3000 → 3001 stay familiar per framework.
 *
 * `taken` holds ports other MADE dev servers are already on. Skipping them is
 * not just politeness: probing a sibling's port would come back "busy" anyway,
 * and every wasted probe is a TCP connect the user waits through.
 */
export function candidatePorts(
  base: number,
  taken: ReadonlySet<number> = new Set(),
  steps = 10,
): number[] {
  const out: number[] = [];
  // The upper bound allows as many skipped-because-taken ports as candidates,
  // so a run of sibling servers can't starve the list.
  for (let p = base; p <= 65535 && p < base + steps * 2 && out.length < steps; p++) {
    if (p < 1) continue;
    if (taken.has(p)) continue;
    out.push(p);
  }
  return out;
}

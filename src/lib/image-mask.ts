/**
 * Per-terminal registry of image-path → display-mask substitutions.
 *
 * Writes into the PTY stay as real file paths (so CLIs can read the image),
 * but when the shell echoes the path back through PTY stdout, TerminalPane's
 * flushPtyBatch replaces registered paths with their masks (e.g. "[Image #1]")
 * before handing bytes to xterm.
 *
 * Happy-path only: contiguous substring match on each batched PTY chunk.
 * If the echo is split across chunks, the mask does not apply.
 */

type Entry = { path: string; mask: string; expiresAt: number };

const registry = new Map<string, Entry[]>();
const TTL_MS = 60_000;

function prune(list: Entry[], now: number): Entry[] {
  return list.filter((e) => e.expiresAt > now);
}

export function registerImageMask(
  terminalId: string,
  path: string,
  imageNumber: number,
): void {
  if (!terminalId || !path) return;
  const mask = `[Image #${imageNumber}]`;
  const now = Date.now();
  const list = registry.get(terminalId) ?? [];
  const next = prune(list, now).filter((e) => e.path !== path);
  next.push({ path, mask, expiresAt: now + TTL_MS });
  // Longest-path-first so nested paths don't mis-replace.
  next.sort((a, b) => b.path.length - a.path.length);
  registry.set(terminalId, next);
}

export function applyImageMask(terminalId: string, text: string): string {
  const list = registry.get(terminalId);
  if (!list || list.length === 0) return text;
  const now = Date.now();
  const alive = prune(list, now);
  if (alive.length !== list.length) {
    if (alive.length === 0) registry.delete(terminalId);
    else registry.set(terminalId, alive);
  }
  let out = text;
  for (const e of alive) {
    if (out.includes(e.path)) {
      out = out.split(e.path).join(e.mask);
    }
  }
  return out;
}

export function clearImageMasks(terminalId: string): void {
  registry.delete(terminalId);
}

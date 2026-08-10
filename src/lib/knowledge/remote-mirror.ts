/**
 * Mirrored remote projects — when an SSH project's folder is really a folder on
 * THIS machine.
 *
 * NexusMind is local-only because "shared memory is a database plus a watched
 * folder on the machine that runs MADE". That reasoning holds for a project
 * whose files live on the server. It does NOT hold for the common share setup:
 * the project lives on the machine running MADE, that machine shares the folder
 * (SMB), the server mounts it, and the SSH pane runs a CLI against the very same
 * bytes. There the database and the watcher are already in the right place —
 * only the path needs translating.
 *
 * So this module answers one question: **is this remote path a local path in
 * disguise, and can we prove it?** Everything downstream then runs unchanged,
 * against a local path, and `knowledge::is_remote_path` in Rust never sees a
 * remote path at all — it stays exactly as strict as it is today.
 *
 * # Prove, never guess
 *
 * A wrong mapping is not a missing feature, it is a correctness bug: it would
 * attach one project's memory to a DIFFERENT project and scaffold
 * `.project-memory/` into it. So a mapping is only ever used when it has been
 * proven, by one of two means:
 *
 * - `probeMirror` — a nonce round-trip through the share (writes one file).
 * - `revalidateMirror` — a byte compare of a file both sides can already see
 *   (writes nothing). Only possible once the project is initialised.
 *
 * A mapping inherited from a proven SIBLING is treated as a *proposal*, not a
 * fact — see `resolveMirror`. That costs one click and buys the guarantee.
 *
 * # Direction matters
 *
 * This only supports "the files are local to MADE, the server borrows them over
 * a share". The reverse — a project living on the server that MADE mounts — is
 * still unsupported, and deliberately: a WAL SQLite database over a share is
 * the "database is locked" failure that `knowledge/mod.rs` keeps the database
 * out of the project to avoid.
 */

import { invoke } from "@tauri-apps/api/core";

import { useAppStore } from "../../store";
import type { RemoteMount, RemoteServer } from "../../types";
import { isWindows } from "../platform";
import { MEMORY_DIR_NAME, canonicalProjectKey, projectLeafName } from "./keys";

/** The probe file, written into the project root and removed again. */
const PROBE_FILE = ".made-mount-probe";

/** Path separator on the machine running MADE. */
function localSep(): string {
  return isWindows() ? "\\" : "/";
}

/** Trim trailing separators without eating a bare root (`/` or `C:\`). */
function trimTrailing(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed || path;
}

function splitSegments(path: string): string[] {
  return trimTrailing(path)
    .split(/[\\/]+/)
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * Connection fields the `ssh_*` commands expect.
 *
 * Key auth is a hard requirement, not a preference: every `ssh_*` primitive
 * runs `BatchMode=yes`, so a password-auth server cannot be probed at all.
 * Saying so beats a probe that hangs and then fails for an unrelated-looking
 * reason. Same rule as `git-invoke.ts` and the file browser.
 */
function sshTargetFor(
  server: RemoteServer,
): { host: string; username: string; identityFile: string } | null {
  if (server.authMethod !== "ssh-key" || !server.sshKeyPath) return null;
  return { host: server.host, username: server.username, identityFile: server.sshKeyPath };
}

function serverById(serverId: string | undefined): RemoteServer | undefined {
  if (!serverId) return undefined;
  return useAppStore.getState().servers.find((s) => s.id === serverId);
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Longest matching mount, so an exact project pair always beats the broader
 * parent rule it was derived from.
 *
 * Remote paths are POSIX and compared case-sensitively — a case-folding match
 * here would be inventing a filesystem property the server may not have.
 */
function matchMount(server: RemoteServer, remotePath: string): RemoteMount | null {
  const path = trimTrailing(remotePath);
  if (!path) return null;
  let best: RemoteMount | null = null;
  for (const mount of server.mounts ?? []) {
    const prefix = trimTrailing(mount.remotePrefix);
    if (path !== prefix && !path.startsWith(`${prefix}/`)) continue;
    if (!best || prefix.length > trimTrailing(best.remotePrefix).length) best = mount;
  }
  return best;
}

/** Apply a mount: `<remotePrefix>/a/b` → `<localPrefix><sep>a<sep>b`. */
function applyMount(mount: RemoteMount, remotePath: string): string {
  const prefix = trimTrailing(mount.remotePrefix);
  const rest = trimTrailing(remotePath).slice(prefix.length).replace(/^\//, "");
  const local = trimTrailing(mount.localPrefix);
  if (!rest) return local;
  return local + localSep() + rest.split("/").join(localSep());
}

/** The local twin of a remote path under this server's mounts, or null. */
export function localTwinOf(server: RemoteServer, remotePath: string): string | null {
  const mount = matchMount(server, remotePath);
  return mount ? applyMount(mount, remotePath) : null;
}

// No local→remote counterpart. Nothing needs one: every consumer starts from a
// tab's remote directory and wants the local path. Writing one anyway would
// mean rebuilding a remote path out of `canonicalProjectKey` output, which is
// lowercased on Windows — silently wrong against a case-sensitive server.

// ---------------------------------------------------------------------------
// Resolution — the single choke point every knowledge surface calls
// ---------------------------------------------------------------------------

export type MirrorResolution =
  /** Not a remote tab. `path` is the working directory itself. */
  | { kind: "local"; path: string }
  /** A remote tab whose exact folder has been proven. Safe to use. */
  | { kind: "linked"; path: string }
  /**
   * A remote tab covered by a mount proven on a SIBLING folder. Very likely
   * right, never assumed: the link panel pre-fills `path` and one click proves
   * it. The gap this closes is a share mounted per-folder (macOS `/Volumes/*`),
   * where sibling A being shared says nothing about sibling B.
   */
  | { kind: "proposed"; path: string }
  /** A remote tab with nothing to go on. */
  | { kind: "unlinked" };

/**
 * Resolve a tab's knowledge target.
 *
 * The ONE function that decides whether a tab has knowledge and at which path.
 * Every surface reads this rather than testing `serverId` itself — the scattered
 * `if (serverId)` guards this replaces are exactly how the feature ended up with
 * ten independent definitions of "not available here".
 *
 * `usableKnowledgePath` is the shorthand for callers that only need the path.
 */
export function resolveMirror(rootDir: string, serverId?: string): MirrorResolution {
  if (!serverId) return { kind: "local", path: rootDir };
  const server = serverById(serverId);
  if (!server) return { kind: "unlinked" };

  // A stored mount is a PROVEN pair, so it — and anything beneath it — is safe
  // to use directly.
  const mount = matchMount(server, rootDir);
  if (mount) return { kind: "linked", path: applyMount(mount, rootDir) };

  // Nothing proven covers this folder, but a SIBLING of a proven one is still a
  // strong guess. Derived here rather than stored, so that removing a link
  // removes exactly one thing and the settings list stays one row per folder
  // the user actually linked.
  const parents = (server.mounts ?? [])
    .map((m) => deriveParentMount(m.remotePrefix, m.localPrefix))
    .filter((m): m is RemoteMount => m !== null);
  const parent = matchMount({ ...server, mounts: parents }, rootDir);
  return parent ? { kind: "proposed", path: applyMount(parent, rootDir) } : { kind: "unlinked" };
}

/**
 * The local path to run knowledge against, or null when there is none.
 *
 * Null on a remote tab means "show the link panel", never "broken".
 */
export function usableKnowledgePath(rootDir: string, serverId?: string): string | null {
  const r = resolveMirror(rootDir, serverId);
  return r.kind === "local" || r.kind === "linked" ? r.path : null;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/**
 * Local folders that might be this remote folder, best first.
 *
 * The cheap signal is the leaf name: `/Volumes/projects/2codeCC` and
 * `…\projects\2codeCC` are the same folder seen from two machines, and MADE
 * already knows every local project the user has opened. Case-insensitive
 * because the local side may be NTFS.
 *
 * Deliberately NOT parsing `mount` on the server and `net share` here. That
 * would add two platform-specific parsers and a hostname-matching problem
 * (NetBIOS vs mDNS vs Tailscale vs IP) to produce candidates this already
 * finds — and every candidate has to survive the probe anyway.
 */
export function proposeLocalTwins(remotePath: string): string[] {
  const leaf = projectLeafName(remotePath).toLowerCase();
  if (!leaf) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const project of useAppStore.getState().recentProjects) {
    if (project.serverId) continue;
    if (projectLeafName(project.path).toLowerCase() !== leaf) continue;
    const key = canonicalProjectKey(project.path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(project.path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------

/** Which step of the probe failed — the panel names it rather than saying "failed". */
export type MirrorProbeStage = "auth" | "local-write" | "remote-read" | "remote-write" | "local-read";

export interface MirrorProbeResult {
  ok: boolean;
  stage?: MirrorProbeStage;
  detail?: string;
}

const PROBE_MESSAGE: Record<MirrorProbeStage, string> = {
  auth: "This server uses password auth. Linking needs an SSH key — every remote command MADE runs is non-interactive.",
  "local-write": "Could not write a test file into the local folder.",
  "remote-read": "The server cannot see the local folder's contents — these are not the same folder.",
  "remote-write": "The server can read the folder but not write to it. An agent there could never save memory.",
  "local-read": "The server's write did not appear locally. Not one shared folder (a syncing folder would look like this).",
};

function fail(stage: MirrorProbeStage, detail?: string): MirrorProbeResult {
  return { ok: false, stage, detail: detail || PROBE_MESSAGE[stage] };
}

/**
 * Prove that a remote folder and a local folder are the same folder.
 *
 * One file, written into the local project root and removed again:
 *
 *   1. local write nonce A → 2. remote read must equal A
 *   → 3. remote write nonce B into the SAME file → 4. local read must equal B
 *   → 5. delete
 *
 * Step 4 is the one that matters. It proves a write made ON THE SERVER lands in
 * the directory the local `notify` watcher is watching, which is the entire
 * mechanism by which a remote agent's `.project-memory/` edits become authored
 * revisions. Steps 1-2 alone would only prove the server can READ.
 *
 * **No sleeps and no retries.** Instant or it is not one filesystem — that is
 * what stops a Dropbox/Syncthing folder, which would eventually converge, from
 * passing as a mount.
 *
 * Ordering keeps the far side clean: nothing is written on the server until the
 * read in step 2 has already proven it is the same folder, so a failed probe
 * can never leave a file on a machine it does not belong on.
 *
 * The caller must have asked for this. MADE does not write into a project
 * unprompted, and neither does the rest of this feature.
 */
export async function probeMirror(
  server: RemoteServer,
  remoteRoot: string,
  localRoot: string,
): Promise<MirrorProbeResult> {
  const target = sshTargetFor(server);
  if (!target) return fail("auth");

  const localFile = `${trimTrailing(localRoot)}${localSep()}${PROBE_FILE}`;
  const remoteFile = `${trimTrailing(remoteRoot)}/${PROBE_FILE}`;
  const nonceA = `made-mount-probe-a-${crypto.randomUUID()}`;
  const nonceB = `made-mount-probe-b-${crypto.randomUUID()}`;

  // Recycle Bin, not a raw unlink: MADE has exactly one delete path and it is
  // the recoverable one (`fs_ops.rs`). One tiny entry per link is the price.
  const cleanup = async () => {
    try {
      await invoke("fs_delete_to_trash", { root: trimTrailing(localRoot), path: localFile });
    } catch {
      // Best effort. A stranded dotfile is noise, not damage, and the next
      // probe overwrites it.
    }
  };

  try {
    await invoke("write_file", { path: localFile, content: nonceA });
  } catch (e) {
    return fail("local-write", `Could not write ${PROBE_FILE}: ${String(e)}`);
  }

  try {
    const seen = await invoke<string>("ssh_read_file", { ...target, path: remoteFile });
    if (seen.trim() !== nonceA) {
      await cleanup();
      return fail("remote-read");
    }
  } catch {
    await cleanup();
    return fail("remote-read");
  }

  try {
    await invoke("ssh_write_file", { ...target, path: remoteFile, content: nonceB });
  } catch (e) {
    await cleanup();
    return fail("remote-write", `${PROBE_MESSAGE["remote-write"]} (${String(e)})`);
  }

  let back = "";
  try {
    back = await invoke<string>("read_file", { path: localFile });
  } catch (e) {
    await cleanup();
    return fail("local-read", `${PROBE_MESSAGE["local-read"]} (${String(e)})`);
  }
  await cleanup();
  if (back.trim() !== nonceB) return fail("local-read");

  return { ok: true };
}

/**
 * Re-check a stored link without writing anything.
 *
 * Compares the bytes of a file both sides can already see. Returns `null` when
 * there is nothing to compare — an uninitialised project has no memory to
 * mis-attach, so silence is the honest answer rather than a fabricated verdict.
 *
 * Cheap enough to run once per server per session; one SSH round-trip, no
 * connection multiplexing anywhere in MADE so it is not free either.
 */
const revalidated = new Map<string, boolean | null>();

/**
 * `revalidateMirror`, at most once per link per app session.
 *
 * The sidebar mounts on every switch to the Knowledge tab, and MADE has no SSH
 * connection multiplexing — an unmemoised check would spend a fresh handshake
 * on every glance at the panel to re-answer a question whose answer only
 * changes when the user remounts a share.
 */
export async function revalidateMirrorOnce(
  server: RemoteServer,
  localRoot: string,
  remoteRoot: string,
): Promise<boolean | null> {
  const cacheKey = `${server.id}|${trimTrailing(remoteRoot)}`;
  if (revalidated.has(cacheKey)) return revalidated.get(cacheKey) ?? null;
  const verdict = await revalidateMirror(server, localRoot, remoteRoot);
  // `null` is cached too: "nothing to compare" is a settled answer for an
  // uninitialised project, and re-asking it costs the same round-trip.
  revalidated.set(cacheKey, verdict);
  return verdict;
}

/** Forget a cached verdict, so the next check actually runs. */
export function forgetRevalidation(serverId: string, remoteRoot: string): void {
  revalidated.delete(`${serverId}|${trimTrailing(remoteRoot)}`);
}

export async function revalidateMirror(
  server: RemoteServer,
  localRoot: string,
  remoteRoot: string,
): Promise<boolean | null> {
  const target = sshTargetFor(server);
  if (!target) return null;

  const rel = `${MEMORY_DIR_NAME}/.system/manifest.json`;
  let local: string;
  try {
    local = await invoke<string>("read_file", {
      path: `${trimTrailing(localRoot)}${localSep()}${rel.split("/").join(localSep())}`,
    });
  } catch {
    return null; // Not initialised — nothing to verify and nothing at stake.
  }

  try {
    const remote = await invoke<string>("ssh_read_file", {
      ...target,
      path: `${trimTrailing(remoteRoot)}/${rel}`,
    });
    return remote.trim() === local.trim();
  } catch {
    return false; // Initialised locally but unreadable there — link is stale.
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * The parent-folder rule a proven project pair implies.
 *
 * Strips exactly ONE segment — the project's own name. Stripping every matching
 * trailing segment would over-generalise badly: `/Volumes/projects/2codeCC` and
 * `C:\…\Documents\projects\2codeCC` share two, and the greedy answer
 * `/Volumes` ↔ `C:\…\Documents` is plainly wrong, because `/Volumes/made` is a
 * different share entirely. One segment says only "the folder holding this
 * project corresponds", which is the most the probe actually showed — and even
 * that only ever produces a PROPOSAL, never a usable link.
 *
 * Returns null when either side would be left as a bare root.
 */
function deriveParentMount(remoteRoot: string, localRoot: string): RemoteMount | null {
  const remoteSegments = splitSegments(remoteRoot);
  const localSegments = splitSegments(localRoot);
  if (remoteSegments.length < 2 || localSegments.length < 2) return null;

  const remotePrefix = `/${remoteSegments.slice(0, -1).join("/")}`;
  const localPrefix = localSegments.slice(0, -1).join(localSep());
  // A Windows drive root ("C:") is a root, not a folder worth generalising to.
  if (localSegments.length === 2 && /^[a-z]:$/i.test(localSegments[0])) return null;
  return { remotePrefix, localPrefix, verifiedAt: Date.now(), source: "probe" };
}

/**
 * Record one proven pair.
 *
 * Exactly one entry per folder the user linked — the parent rule its siblings
 * ride on is computed in `resolveMirror`, never stored. That keeps the stored
 * list equal to the list of things the user did, which is what makes "Unlink"
 * in Settings mean something they can predict.
 */
export function saveProvenMirror(
  serverId: string,
  remoteRoot: string,
  localRoot: string,
  source: RemoteMount["source"] = "probe",
): void {
  const server = serverById(serverId);
  if (!server) return;

  const mount: RemoteMount = {
    remotePrefix: trimTrailing(remoteRoot),
    localPrefix: trimTrailing(localRoot),
    verifiedAt: Date.now(),
    source,
  };
  const next = [...(server.mounts ?? [])];
  const at = next.findIndex(
    (m) => trimTrailing(m.remotePrefix) === trimTrailing(mount.remotePrefix),
  );
  if (at === -1) next.push(mount);
  else next[at] = mount;
  useAppStore.getState().updateServer(serverId, { mounts: next });
}

/** Drop one mount by its remote prefix. */
export function removeMirror(serverId: string, remotePrefix: string): void {
  const server = serverById(serverId);
  if (!server?.mounts) return;
  const wanted = trimTrailing(remotePrefix);
  useAppStore.getState().updateServer(serverId, {
    mounts: server.mounts.filter((m) => trimTrailing(m.remotePrefix) !== wanted),
  });
}

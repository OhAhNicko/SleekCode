#!/usr/bin/env node
/**
 * End-to-end smoke test for the `made-knowledge-mcp` adapter.
 *
 * Stands up a MOCK knowledge service — a loopback NDJSON server speaking the
 * exact dialect of `src-tauri/src/knowledge/ipc.rs` — points the real, freshly
 * built adapter at it through `MADE_KNOWLEDGE_ENDPOINT`, and drives it over
 * stdio as an MCP client would.
 *
 * What it proves, in order:
 *   1. `initialize` succeeds and advertises tools, resources and prompts.
 *   2. `tools/list` returns all 15, with underscore names.
 *   3. A `tools/call` round-trip reaches the service with trusted identity —
 *      the agent kind from `--agent`, the pane from `MADE_PANE_ID` — and with
 *      the forged identity fields stripped out of the arguments.
 *   4. A stale-revision conflict comes back as `isError: false` carrying the
 *      data needed to rebase, not as a protocol exception.
 *   5. Killing the service mid-run degrades to a per-call error while the
 *      PROCESS STAYS ALIVE — a CLI must not have to restart because MADE did.
 *   6. Closing stdin exits 0.
 *
 * Run from WSL or Windows:  node scripts/knowledge-mcp-smoke.mjs
 * Build the adapter first:  cargo build --bin made-knowledge-mcp
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "smoke-token-0123456789abcdef";
/** A search query the mock deliberately never answers. See `startMockService`. */
const SWALLOW = "__never-answered__";

/**
 * `/mnt/c/x` → `C:\x`.
 *
 * The adapter under test is a WINDOWS executable, and this script usually runs
 * under WSL node. Every path handed ACROSS that boundary — the endpoint file it
 * opens, the directory it runs in — has to be spelled the way Windows spells
 * it, or it silently reads as "no endpoint file" and the whole run degrades to
 * the service-down path while appearing to work.
 *
 * The scratch directory therefore lives under the repo (which is on the C:
 * drive) rather than in /tmp, which has no Windows spelling at all.
 */
function forAdapter(p) {
  if (process.platform !== "linux") return p;
  const m = /^\/mnt\/([a-z])\/(.*)$/.exec(p);
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}` : p;
}

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) {
    failures += 1;
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}

/* --------------------------------------------------------------------------
 * Locate the adapter
 * ------------------------------------------------------------------------ */

/**
 * Prefer the debug build, fall back to release. Both spellings of the exe name
 * are tried because this script runs from WSL against a Windows-built binary.
 */
function findAdapter() {
  const bases = [
    join(root, "src-tauri", "target", "debug"),
    join(root, "src-tauri", "target", "release"),
  ];
  for (const base of bases) {
    for (const name of ["made-knowledge-mcp.exe", "made-knowledge-mcp"]) {
      const candidate = join(base, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/* --------------------------------------------------------------------------
 * Mock knowledge service — the ipc.rs dialect, and nothing more
 * ------------------------------------------------------------------------ */

function startMockService(projectRoot, { swallow = false } = {}) {
  const state = { hello: null, calls: [], sockets: new Set() };

  const server = createServer((socket) => {
    state.sockets.add(socket);
    socket.on("close", () => state.sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const reply = (obj) => socket.write(`${JSON.stringify(obj)}\n`);

        if (msg.kind === "hello") {
          if (msg.token !== TOKEN) {
            reply({ kind: "hello-err", code: "bad-token" });
            socket.end();
            continue;
          }
          state.hello = msg;
          reply({
            kind: "hello-ok",
            projectKey: projectRoot.replace(/\\/g, "/").toLowerCase(),
            projectRoot,
            mode: "rw",
            sessionId: "mock-session",
            writePolicy: "trusted",
          });
          continue;
        }

        state.calls.push(msg);
        // A request this instance accepts and never answers, so the caller is
        // parked in `pending` when the socket dies. The only way to stage "N
        // calls were in flight when MADE restarted" from out here.
        //
        // Per-INSTANCE: the replacement service must answer the retried call,
        // or the retry parks again and the test measures a read timeout
        // instead of the recovery it is about.
        if (swallow && msg.params?.query === SWALLOW) continue;
        reply(respond(msg));
      }
    });
  });

  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => resolveServer({ server, state, port: server.address().port }));
  });
}

/** Canned answers, shaped exactly like `ipc::dispatch` produces them. */
function respond(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case "search":
      return {
        id,
        ok: [
          {
            entityId: "kn_1",
            title: "Current state",
            type: "state",
            filePath: "STATE.md",
            snippet: "…the <b>thing</b> works…",
            updatedAt: 1785442320000,
            updatedBy: { kind: "agent", agentKind: "codex" },
          },
        ],
      };
    case "get_doc":
    case "get_note":
      return {
        id,
        ok: {
          meta: {
            id: "kn_1",
            type: params.kind ?? "note",
            title: "Current state",
            revision: 4,
            createdBy: { kind: "user" },
            updatedBy: { kind: "agent", agentKind: "codex" },
            createdAt: 1785442320000,
            updatedAt: 1785442320000,
            tags: ["core"],
          },
          content: "# Current state\n\nEverything is fine.\n",
        },
      };
    case "list_note_summaries":
      return { id, ok: [{ id: "kn_1", title: "Current state", type: "state", revision: 4 }] };
    case "list_recent_changes":
      return {
        id,
        ok: {
          events: [
            {
              seq: 12,
              eventType: "note.updated",
              summary: "updated STATE.md",
              actor: { kind: "agent", agentKind: "claude" },
              createdAt: 1785442320000,
            },
          ],
          latestSeq: 12,
        },
      };
    case "create_note":
      return { id, ok: { status: "ok", id: "kn_new", revision: 1, filePath: "notes/new.md" } };
    case "update_note":
      // A stale base revision is the conflict path — the whole reason
      // baseRevision exists.
      if ((params.baseRevision ?? 0) < 4) {
        return {
          id,
          err: {
            code: "conflict",
            message: "this note changed since the revision you edited",
            data: {
              status: "conflict",
              id: params.id,
              revision: 4,
              conflict: {
                id: "cfl_1",
                currentRevision: 4,
                currentContent: "# Current state\n\nSomeone else's words.\n",
                currentUpdatedBy: "claude",
                currentUpdatedAt: 1785442320000,
              },
            },
          },
        };
      }
      return { id, ok: { status: "ok", id: params.id, revision: 5, filePath: "STATE.md" } };
    case "session-info":
      return { id, ok: { ok: true } };
    default:
      return { id, ok: {} };
  }
}

/* --------------------------------------------------------------------------
 * Minimal MCP client over the adapter's stdio
 * ------------------------------------------------------------------------ */

function startClient(adapter, endpointFile, projectDir) {
  const child = spawn(adapter, ["--agent", "claude"], {
    // Deliberately a SUBDIRECTORY of the project: the adapter has to walk up to
    // the `.project-memory` marker, which is the real shape of a CLI started
    // somewhere inside a repo.
    cwd: projectDir,
    env: {
      ...process.env,
      MADE_KNOWLEDGE_ENDPOINT: forAdapter(endpointFile),
      MADE_PANE_ID: "term-smoke-1",
      // WSL forwards ONLY what WSLENV names. Setting the two variables without
      // this reaches a Windows child with neither — which is precisely the
      // mechanism `wslenv_with_pane_id` exists for in MADE's own setup(), so
      // exercising it here is the point rather than a workaround.
      //
      // `/w` (forward, no translation) rather than `/p`: the endpoint path is
      // already in Windows form, and `/p` would translate it a second time.
      ...(process.platform === "linux"
        ? {
            WSLENV: [process.env.WSLENV, "MADE_PANE_ID/w", "MADE_KNOWLEDGE_ENDPOINT/w"]
              .filter(Boolean)
              .join(":"),
          }
        : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  let nextId = 1;
  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      }
    }
  });

  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));

  const request = (method, params) =>
    new Promise((resolveCall, rejectCall) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectCall(new Error(`${method} never answered`));
      }, 20_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveCall(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

  return { child, request, notify, stderr };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------------
 * The run
 * ------------------------------------------------------------------------ */

async function main() {
  const adapter = findAdapter();
  if (!adapter) {
    console.error(
      "No adapter binary found. Build it first:\n" +
        "  cargo build --bin made-knowledge-mcp   (from src-tauri/)",
    );
    process.exit(1);
  }
  console.log(`adapter: ${adapter}\n`);

  // The memory folder's name is per-BUILD (live/dev isolation): a debug
  // adapter walks for `.project-memory-dev`, a release one for
  // `.project-memory`. Derive it from which binary we found, or the root walk
  // silently misses the marker and every project-scoped check lies.
  const memoryDirName = /[\\/]debug[\\/]/.test(adapter)
    ? ".project-memory-dev"
    : ".project-memory";

  // Under the repo, not /tmp: the Windows adapter has to be able to open both
  // the endpoint file and its own working directory.
  const tmp = mkdtempSync(join(root, ".knowledge-mcp-smoke-"));
  const projectRoot = join(tmp, "project");
  const startDir = join(projectRoot, "src", "deep");
  mkdirSync(join(projectRoot, memoryDirName), { recursive: true });
  mkdirSync(startDir, { recursive: true });

  const { server, state, port } = await startMockService(forAdapter(projectRoot));
  const endpointFile = join(tmp, "endpoint.json");
  writeFileSync(
    endpointFile,
    JSON.stringify({
      v: 1,
      port,
      token: TOKEN,
      pid: process.pid,
      appVersion: "0.0.0-smoke",
      startedAt: Date.now(),
    }),
  );

  const client = startClient(adapter, endpointFile, startDir);
  let exitCode = null;
  client.child.on("exit", (code) => {
    exitCode = code;
  });

  try {
    /* 1 — initialize */
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke-client", version: "1.0.0" },
    });
    const caps = init.result?.capabilities ?? {};
    check(!init.error, "initialize succeeds", init.error);
    check(Boolean(caps.tools), "advertises tools", caps);
    check(Boolean(caps.resources), "advertises resources", caps);
    check(Boolean(caps.prompts), "advertises prompts", caps);
    check(
      caps.resources?.subscribe !== true,
      "does NOT advertise resource subscriptions",
      caps.resources,
    );
    // Per-build name, like the memory folder: a debug adapter answers
    // `made-knowledge-dev` (live/dev isolation).
    const serverName = /[\\/]debug[\\/]/.test(adapter) ? "made-nexus-dev" : "made-nexus";
    check(
      init.result?.serverInfo?.name === serverName,
      `identifies itself as ${serverName}`,
      init.result?.serverInfo,
    );
    client.notify("notifications/initialized", {});

    /* 2 — tools/list */
    const tools = await client.request("tools/list", {});
    const names = (tools.result?.tools ?? []).map((t) => t.name);
    check(names.length === 15, `tools/list returns 15 (got ${names.length})`, names);
    check(
      names.every((n) => /^knowledge_[a-z_]+$/.test(n)),
      "every tool name is underscore-cased",
      names,
    );
    check(names.includes("knowledge_search"), "knowledge_search is present");
    check(names.includes("knowledge_create_handoff"), "knowledge_create_handoff is present");

    /* 3 — a real round trip, with an identity-forgery attempt in the args */
    const search = await client.request("tools/call", {
      name: "knowledge_search",
      arguments: {
        query: "state",
        agentKind: "gemini",
        paneId: "term-somebody-else",
        sessionId: "borrowed",
      },
    });
    check(search.result?.isError === false, "search returns a non-error result", search);
    const searchCall = state.calls.find((c) => c.method === "search");
    check(Boolean(searchCall), "the call reached the service");
    check(searchCall?.params?.query === "state", "the real argument survived", searchCall?.params);
    for (const forged of ["agentKind", "paneId", "sessionId"]) {
      check(
        searchCall?.params?.[forged] === undefined,
        `forged ${forged} was stripped from the frame`,
        searchCall?.params,
      );
    }
    check(
      state.hello?.agent === "claude",
      "the handshake carries the --agent kind, not the model's claim",
      state.hello?.agent,
    );
    check(
      state.hello?.paneId === "term-smoke-1",
      "MADE_PANE_ID reached the handshake",
      state.hello?.paneId,
    );
    check(
      typeof state.hello?.projectRootGuess === "string",
      "the cwd ancestor walk found the project",
      state.hello?.projectRootGuess,
    );

    /* resources — the fixed set plus whatever the service listed */
    const resources = await client.request("resources/list", {});
    const uris = (resources.result?.resources ?? []).map((r) => r.uri);
    check(uris.includes("knowledge://project/state"), "the state resource is listed", uris);
    check(uris.includes("knowledge://changes/recent"), "the change log is listed", uris);
    const read = await client.request("resources/read", { uri: "knowledge://project/state" });
    const text = read.result?.contents?.[0]?.text ?? "";
    check(text.startsWith("---\n"), "a resource reads as markdown with frontmatter", text.slice(0, 40));
    check(text.includes("revision: 4"), "the frontmatter carries the revision to write back with");
    check(text.includes("updated_by: codex"), "attribution survives into the frontmatter");

    /* prompts — live content, not just instructions */
    const prompts = await client.request("prompts/list", {});
    check((prompts.result?.prompts ?? []).length === 4, "prompts/list returns 4", prompts.result);
    const prompt = await client.request("prompts/get", {
      name: "review-recent-knowledge-changes",
      arguments: {},
    });
    const promptText = prompt.result?.messages?.[0]?.content?.text ?? "";
    check(promptText.includes("updated STATE.md"), "a prompt carries live fetched content");

    /* 4 — the conflict shape */
    const conflict = await client.request("tools/call", {
      name: "knowledge_update_note",
      arguments: { id: "kn_1", baseRevision: 2, content: "# Current state\n\nMine.\n" },
    });
    check(
      conflict.result?.isError === false,
      "a stale write is NOT reported as a tool error",
      conflict.result,
    );
    check(
      conflict.result?.structuredContent?.conflict?.currentRevision === 4,
      "the conflict carries the current revision to rebase onto",
      conflict.result?.structuredContent,
    );
    const conflictText = conflict.result?.content?.[0]?.text ?? "";
    check(conflictText.includes("baseRevision"), "and tells the caller how to retry");

    /* 4b — a write missing its revision must never reach the service */
    const callsBefore = state.calls.length;
    const incomplete = await client.request("tools/call", {
      name: "knowledge_update_state",
      arguments: { content: "# Current state\n\nOverwritten.\n" },
    });
    check(
      incomplete.result?.isError === true,
      "update_state without baseRevision is refused",
      incomplete.result,
    );
    const incompleteText = incomplete.result?.content?.[0]?.text ?? "";
    check(incompleteText.includes("baseRevision"), "and names the missing field", incompleteText);
    check(
      incompleteText.includes("knowledge_get_note"),
      "and says where to get a value for it",
      incompleteText,
    );
    check(
      state.calls.length === callsBefore,
      "and the frame never reached the service at all",
      state.calls.slice(callsBefore).map((c) => c.method),
    );

    /* 5 — the service dies; the adapter must not */
    server.close();
    for (const socket of state.sockets) socket.destroy();
    await sleep(300);

    const orphaned = await client.request("tools/call", {
      name: "knowledge_search",
      arguments: { query: "anything" },
    });
    check(orphaned.result?.isError === true, "a call with the service gone is an error", orphaned);
    const downText = orphaned.result?.content?.[0]?.text ?? "";
    check(downText.includes("MADE is not running"), "and it says so plainly", downText);
    check(downText.includes(`${memoryDirName}/`), "and names the fallback that still works");

    const stillListing = await client.request("resources/list", {});
    check(
      !stillListing.error && (stillListing.result?.resources ?? []).length >= 8,
      "resources/list still answers with the fixed set",
      stillListing.error,
    );
    const stillTools = await client.request("tools/list", {});
    check(
      (stillTools.result?.tools ?? []).length === 15,
      "tools/list is unaffected by the service being gone",
    );
    check(exitCode === null, "the adapter process is still alive", exitCode);

    /* 5b — MADE restarts with N calls already in flight.
     *
     * EVERY one of them has to recover, not just the first to notice. The retry
     * decision used to be read off the connection slot, so exactly one caller
     * found the dead socket and retried while the rest reported "MADE is not
     * running" about a service that was already back.
     *
     * Staging it needs the calls genuinely PARKED when the socket dies —
     * reconnect-on-next-call recovers without the retry path at all, and would
     * pass either way. Hence the swallowed query. */
    const alive = await startMockService(forAdapter(projectRoot), { swallow: true });
    writeFileSync(
      endpointFile,
      JSON.stringify({ v: 1, port: alive.port, token: TOKEN, pid: process.pid, startedAt: Date.now() }),
    );
    await sleep(3500); // past the negative cache

    // Three calls the service accepts and never answers.
    const parked = [
      client.request("tools/call", { name: "knowledge_search", arguments: { query: SWALLOW } }),
      client.request("tools/call", { name: "knowledge_search", arguments: { query: SWALLOW } }),
      client.request("tools/call", { name: "knowledge_search", arguments: { query: SWALLOW } }),
    ];
    // Wait until all three have actually reached the service, or they are not
    // in flight and this proves nothing.
    for (let i = 0; i < 100 && alive.state.calls.filter((c) => c.params?.query === SWALLOW).length < 3; i++) {
      await sleep(50);
    }
    const reached = alive.state.calls.filter((c) => c.params?.query === SWALLOW).length;
    check(reached === 3, `3 calls are parked in flight (got ${reached})`);

    // The replacement instance is listening and discoverable BEFORE the old
    // sockets die. That is deliberate: the adapter's retry is one-shot and does
    // not wait out an app restart, so a test that killed first would only be
    // measuring how fast this script can start a server. What is under test is
    // whether EVERY parked caller gets that retry, not whether one attempt can
    // outrun a restart.
    const restarted = await startMockService(forAdapter(projectRoot));
    writeFileSync(
      endpointFile,
      JSON.stringify({
        v: 1,
        port: restarted.port,
        token: TOKEN,
        pid: process.pid,
        appVersion: "0.0.0-smoke-restarted",
        startedAt: Date.now(),
      }),
    );
    alive.server.close();
    for (const socket of alive.state.sockets) socket.destroy();

    const recovered = (await Promise.all(parked)).filter((r) => r.result?.isError === false);
    check(
      recovered.length === 3,
      `all 3 in-flight calls recover across the restart (got ${recovered.length})`,
    );
    check(
      restarted.state.hello?.agent === "claude" && restarted.state.hello?.paneId === "term-smoke-1",
      "the reconnect re-handshakes with the same trusted identity",
      restarted.state.hello,
    );
    restarted.server.close();
    for (const socket of restarted.state.sockets) socket.destroy();

    /* 6 — clean EOF */
    client.child.stdin.end();
    for (let i = 0; i < 100 && exitCode === null; i++) await sleep(50);
    check(exitCode === 0, `closing stdin exits 0 (got ${exitCode})`);
  } catch (e) {
    check(false, `unexpected failure: ${e.message}`);
  } finally {
    client.child.kill();
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check(s)`}`);
  if (failures > 0) {
    console.log("\n--- adapter stderr ---");
    console.log(client.stderr.join(""));
  }
  process.exit(failures === 0 ? 0 : 1);
}

main();

import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAppStore } from "../../store";
import { getDefaultBackend } from "../../lib/platform";
import type { TerminalBackend } from "../../types";
import { KNOWLEDGE_CLIS, type KnowledgeCli } from "../../lib/knowledge/types";
import {
  KNOWLEDGE_CLI_PRODUCT_NAME,
  KNOWLEDGE_MCP_SERVER_NAME,
  MCP_OP_SLOW_MS,
  installKnowledgeMcp,
  isKnowledgeMcpOpBusy,
  knowledgeMcpStatusLabel,
  readKnowledgeMcpConnections,
  readKnowledgeMcpStatus,
  removeKnowledgeMcp,
  runExclusiveKnowledgeMcpOp,
  subscribeKnowledgeMcpOps,
  type KnowledgeMcpRegistration,
} from "../../lib/knowledge/mcp";
import { SECTION_HEADER_STYLE } from "./KnowledgeNotesTree";
import { Spinner } from "./KnowledgeMcpRow";

/**
 * Which agents can actually reach this project's memory — with the repair
 * inline instead of a trip to Settings.
 *
 * This section replaced the footer's per-CLI status chips (which were never
 * wired to a real read and permanently said "Unknown"). It is the sidebar's
 * one per-CLI surface: status from the same detection the settings rows use,
 * plus Set up / Fix for the states that have an obvious next action.
 *
 * `sequential` is the first-run mode: straight after "Initialize NexusMind"
 * the rows appear one at a time, each checked before the next starts, so a new
 * user watches their CLIs come up rather than finding a finished table. Every
 * later mount checks all three at once with no theatrics.
 *
 * Mutations run through `runExclusiveKnowledgeMcpOp` — the module-level
 * per-CLI slot shared with the settings row — because two surfaces writing the
 * same CLI config concurrently is the exact defect that mutex exists to
 * prevent.
 */
interface Props {
  rootDir: string;
  /** True only on the mount right after initialization succeeded. */
  sequential: boolean;
}

const ROW_BUTTON_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "2px 8px",
  fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
  fontWeight: 500,
  color: "var(--ezy-text-secondary)",
  backgroundColor: "var(--ezy-surface)",
  border: "1px solid var(--ezy-border)",
  borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
  fontFamily: "inherit",
  flexShrink: 0,
};

/** undefined = row not revealed yet (sequential mode); null = checking. */
type CliStatuses = Partial<Record<KnowledgeCli, KnowledgeMcpRegistration | null>>;

export default function KnowledgeAgentAccess({ rootDir, sequential }: Props) {
  const terminalBackend = useAppStore((s) => s.terminalBackend);
  const activeServerId = useAppStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.serverId,
  );
  const backend: TerminalBackend = activeServerId ? "ssh" : (terminalBackend ?? getDefaultBackend());

  const [statuses, setStatuses] = useState<CliStatuses>({});
  const [busyCli, setBusyCli] = useState<KnowledgeCli | null>(null);
  const [slow, setSlow] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<KnowledgeCli, string>>>({});
  const [justChanged, setJustChanged] = useState<Partial<Record<KnowledgeCli, true>>>({});

  // The mode is decided at mount: a parent re-render mid-walk must not restart
  // the sequence, and an already-mounted section never becomes "first-run".
  const sequentialRef = useRef(sequential);

  const refreshCli = (cli: KnowledgeCli) => {
    setStatuses((s) => ({ ...s, [cli]: null }));
    void readKnowledgeMcpStatus(cli, backend, rootDir).then((st) =>
      setStatuses((s) => ({ ...s, [cli]: st })),
    );
  };

  useEffect(() => {
    let cancelled = false;
    // A new project or backend is a new conversation — stale hints and errors
    // from the previous one must not carry over.
    setJustChanged({});
    setErrors({});
    const read = (cli: KnowledgeCli) => readKnowledgeMcpStatus(cli, backend, rootDir);
    if (sequentialRef.current) {
      void (async () => {
        for (const cli of KNOWLEDGE_CLIS) {
          if (cancelled) return;
          setStatuses((s) => ({ ...s, [cli]: null }));
          const st = await read(cli);
          if (cancelled) return;
          setStatuses((s) => ({ ...s, [cli]: st }));
        }
      })();
    } else {
      setStatuses(Object.fromEntries(KNOWLEDGE_CLIS.map((c) => [c, null])) as CliStatuses);
      for (const cli of KNOWLEDGE_CLIS) {
        void read(cli).then((st) => {
          if (!cancelled) setStatuses((s) => ({ ...s, [cli]: st }));
        });
      }
    }
    return () => {
      cancelled = true;
    };
  }, [rootDir, backend]);

  // The restart hint clears ITSELF when it stops being true: a live adapter
  // connection from that CLI is proof a (re)started pane picked the server
  // up, which is exactly what the hint asks for. Polled only while a hint is
  // showing — the rest of the time this effect is inert.
  useEffect(() => {
    if (!KNOWLEDGE_CLIS.some((c) => justChanged[c])) return;
    let cancelled = false;
    const check = () => {
      void readKnowledgeMcpConnections().then((conns) => {
        if (cancelled) return;
        const connected = new Set(conns.map((c) => c.agentKind));
        setJustChanged((j) => {
          const still = KNOWLEDGE_CLIS.filter((c) => j[c] && !connected.has(c));
          if (still.length === KNOWLEDGE_CLIS.filter((c) => j[c]).length) return j;
          const next: Partial<Record<KnowledgeCli, true>> = {};
          for (const c of still) next[c] = true;
          return next;
        });
      });
    };
    check();
    const timer = setInterval(check, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [justChanged]);

  // Which CLIs are held by a registration on ANY surface. The snapshot is a
  // string so an unchanged set never re-renders.
  const busySet = useSyncExternalStore(subscribeKnowledgeMcpOps, () =>
    KNOWLEDGE_CLIS.filter((c) => isKnowledgeMcpOpBusy(c)).join(","),
  );

  // When a CLI's operation settles — here or in Settings — its row is stale;
  // re-read it. Own operations refresh twice, which costs one cheap read.
  const prevBusyRef = useRef(busySet);
  useEffect(() => {
    const prev = new Set(prevBusyRef.current.split(",").filter(Boolean));
    const now = new Set(busySet.split(",").filter(Boolean));
    prevBusyRef.current = busySet;
    for (const cli of prev) {
      if (!now.has(cli)) refreshCli(cli as KnowledgeCli);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busySet]);

  const setUp = (cli: KnowledgeCli, fix: boolean) => {
    const status = statuses[cli];
    setBusyCli(cli);
    setSlow(false);
    setErrors((e) => ({ ...e, [cli]: undefined }));
    const slowTimer = setTimeout(() => setSlow(true), MCP_OP_SLOW_MS);
    void (async () => {
      try {
        await runExclusiveKnowledgeMcpOp(cli, async () => {
          // Fix = re-register: remove the entry DETECTION found (any name, any
          // scope), then install at MADE's canonical name and user scope. Same
          // path, same rationale, as the settings row's "Update registration".
          if (fix) {
            await removeKnowledgeMcp(cli, backend, {
              name: status?.name || undefined,
              scope: status?.scope || undefined,
            }).catch(() => "");
          }
          await installKnowledgeMcp(cli, backend);
        });
        setJustChanged((j) => ({ ...j, [cli]: true }));
      } catch (e) {
        setErrors((er) => ({ ...er, [cli]: e instanceof Error ? e.message : String(e) }));
      } finally {
        clearTimeout(slowTimer);
        setSlow(false);
        setBusyCli(null);
      }
    })();
  };

  const busyHeld = new Set(busySet.split(",").filter(Boolean));

  return (
    <div
      style={{
        borderTop: "1px solid var(--ezy-border-subtle)",
        paddingBottom: 6,
        flexShrink: 0,
      }}
    >
      <div style={SECTION_HEADER_STYLE}>
        <span>Agent MCP access</span>
      </div>
      {/* One grid for the whole section: leading status dot, CLI name, and
          the action on the right. The dot is the ONLY state signal — the
          section title carries the "MCP" context and the dot's tooltip
          carries the words ("MCP connected", …), so the rows themselves stay
          wordless (user, 2026-08-08). Sub-lines (slow notice, restart hint,
          error) span the full row. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr auto",
          alignItems: "center",
          columnGap: 8,
          padding: "0 10px",
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          color: "var(--ezy-text-muted)",
        }}
      >
        {KNOWLEDGE_CLIS.map((cli) => {
          const status = statuses[cli];
          if (status === undefined) return null; // sequential mode: not revealed yet
          const checking = status === null;
          const { label, color } = knowledgeMcpStatusLabel(status);
          const configured = !!status?.configured;
          const mismatch =
            configured &&
            (status?.pathMatches === false ||
              (!!status?.name && status.name !== KNOWLEDGE_MCP_SERVER_NAME));
          const actionable = !checking && (!configured || mismatch);
          const held = busyHeld.has(cli) || busyCli !== null;
          const isOwnOp = busyCli === cli;
          const error = errors[cli];
          const subLineStyle: React.CSSProperties = {
            gridColumn: "1 / -1",
            padding: "0 0 3px 12px",
            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
            color: "var(--ezy-text-muted)",
            lineHeight: 1.4,
          };
          return (
            <Fragment key={cli}>
              {/* The state lives in the dot — glossy highlight and a soft
                  STATIC glow (never a pulse); the words live in its tooltip.
                  The 7px dot is an impossible hover target, so the tooltip
                  sits on a padded invisible wrapper. */}
              <span
                data-tooltip={checking ? "Checking…" : label}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: 4,
                  margin: -4,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: checking
                      ? "var(--ezy-text-muted)"
                      : `radial-gradient(circle at 35% 30%, color-mix(in srgb, ${color} 55%, white), ${color} 72%)`,
                    boxShadow: checking
                      ? "none"
                      : `0 0 6px color-mix(in srgb, ${color} 45%, transparent)`,
                  }}
                />
              </span>
              <span
                style={{
                  color: "var(--ezy-text-secondary)",
                  minHeight: 22,
                  display: "inline-flex",
                  alignItems: "center",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {KNOWLEDGE_CLI_PRODUCT_NAME[cli]}
              </span>
              {actionable ? (
                <button
                  onClick={() => {
                    if (!held) setUp(cli, mismatch);
                  }}
                  aria-disabled={held}
                  style={{ ...ROW_BUTTON_STYLE, cursor: held ? "default" : "pointer" }}
                >
                  {isOwnOp && <Spinner />}
                  {isOwnOp
                    ? slow
                      ? "Still running…"
                      : mismatch
                        ? "Fixing…"
                        : "Setting up…"
                    : mismatch
                      ? "Fix"
                      : "Set up"}
                </button>
              ) : (
                <span aria-hidden />
              )}
              {isOwnOp && slow && (
                <div style={subLineStyle}>
                  {KNOWLEDGE_CLI_PRODUCT_NAME[cli]} is taking a while to answer — still running.
                  Don&apos;t start another.
                </div>
              )}
              {justChanged[cli] && configured && !mismatch && (
                <div style={subLineStyle}>Takes effect in new panes.</div>
              )}
              {error && (
                <div
                  data-tooltip={error}
                  style={{
                    ...subLineStyle,
                    color: "var(--ezy-red, #e55)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {error}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

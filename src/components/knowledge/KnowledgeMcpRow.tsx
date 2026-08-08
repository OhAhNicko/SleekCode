import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { TerminalBackend } from "../../types";
import type { KnowledgeCli } from "../../lib/knowledge/types";
import {
  KNOWLEDGE_CLI_PRODUCT_NAME,
  KNOWLEDGE_MCP_SERVER_NAME,
  KNOWLEDGE_MCP_REMOTE_REASON,
  MCP_OP_SLOW_MS,
  installKnowledgeMcp,
  isKnowledgeMcpOpBusy,
  knowledgeMcpStatusLabel,
  readAdapterPath,
  readKnowledgeMcpStatus,
  removeKnowledgeMcp,
  runExclusiveKnowledgeMcpOp,
  subscribeKnowledgeMcpOps,
  type KnowledgeMcpRegistration,
} from "../../lib/knowledge/mcp";

/**
 * One CLI's registration of the `made-knowledge` MCP server.
 *
 * Four states, and the last two are the reason this is not a checkbox:
 *
 *  - **MCP connected** — the CLI will launch MADE's adapter.
 *  - **MCP not set up** — it will not, and Install fixes that.
 *  - **MCP status unknown** — the config could not be read. Never rendered as
 *    "not set up": telling someone to install what they already have is worse
 *    than saying nothing, and it is also how a CLI that isn't on this machine
 *    reads.
 *  - **Registered elsewhere** — configured, but pointing at a different MADE
 *    install's adapter. Left alone this reads as working while every tool call
 *    goes to the wrong place, so it gets its own line and its own repair.
 */
/**
 * The settings-row primitive, passed in rather than imported.
 *
 * `SettingsRow` is private to SettingsPane and also carries the search filter —
 * a row whose label and description don't match the query renders nothing. This
 * component needs that behaviour but must not import it back out of
 * SettingsPane, which would make the two files a cycle. So the layout comes in
 * as a value and this file owns only the state.
 */
type SettingsRowComponent = (props: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) => React.ReactElement | null;

interface Props {
  cli: KnowledgeCli;
  backend: TerminalBackend;
  projectPath?: string;
  Row: SettingsRowComponent;
}

const BUTTON_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 10px",
  fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
  fontWeight: 500,
  color: "var(--ezy-text-secondary)",
  backgroundColor: "var(--ezy-surface)",
  border: "1px solid var(--ezy-border)",
  borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
  fontFamily: "inherit",
};

/** Registering shells out to the CLI and can take tens of seconds — long
 *  enough that a changed label alone reads as a stuck button. Exported for the
 *  sidebar's Agents section, which runs the same operations. */
export function Spinner() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      style={{ animation: "ezy-spin 0.8s linear infinite", flexShrink: 0 }}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="28"
        strokeDashoffset="8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function KnowledgeMcpRow({ cli, backend, projectPath, Row }: Props) {
  const [status, setStatus] = useState<KnowledgeMcpRegistration | null>(null);
  const [busy, setBusy] = useState<"install" | "remove" | "update" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adapter, setAdapter] = useState<string | null>(null);
  /** Set after a successful install, so the hint appears only when it applies. */
  const [justChanged, setJustChanged] = useState(false);
  /** The current operation has run long enough to be worth explaining. */
  const [slow, setSlow] = useState(false);

  const refresh = useCallback(() => {
    setStatus(null);
    void readKnowledgeMcpStatus(cli, backend, projectPath).then(setStatus);
  }, [cli, backend, projectPath]);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    void readAdapterPath().then(setAdapter);
  }, []);

  /**
   * Register or unregister, holding the row for as long as it genuinely takes.
   *
   * Mutual exclusion lives in `runExclusiveKnowledgeMcpOp` — module level,
   * because the sidebar's Agents section can start the same mutation and
   * nothing on the Rust side refuses a second concurrent `mcp add` — and it is
   * released strictly by the real call settling. It used to be released by a
   * 75s timeout race, which meant the button came back to life precisely while
   * a registration was still writing the CLI's config, and the error text said
   * "try again". Two writers on an unlocked ~/.claude.json is how a live
   * pane's servers disappear.
   *
   * A long run is now reported instead of abandoned: the label says so, the
   * control stays held, and no advice to retry is offered while retrying is the
   * wrong thing to do.
   */
  const run = async (kind: "install" | "remove" | "update") => {
    setBusy(kind);
    setError(null);
    setSlow(false);
    const slowTimer = setTimeout(() => setSlow(true), MCP_OP_SLOW_MS);
    try {
      await runExclusiveKnowledgeMcpOp(cli, async () => {
        // "Update registration" is a remove followed by an add: no CLI exposes an
        // edit, and re-adding over an existing name is rejected by at least one
        // of them. Swallowing the remove's failure is safe ONLY because this
        // await now settles when the remove is really over — the entry it targets
        // may legitimately be gone, and failing there would block the repair.
        // Back when the await could be a timeout, this `.catch` started the
        // install on top of a remove that was provably still running.
        //
        // The remove targets the entry DETECTION found, not the one MADE would
        // have written: a Gemini entry added by hand sits at project scope, and a
        // path-mismatched entry may carry any name. Removing at the assumed
        // name/scope deleted nothing and reported success. The install that
        // follows on the update path deliberately does NOT take these — it
        // re-registers at MADE's canonical `made-knowledge` / user scope, which
        // is the whole point of repairing the registration.
        if (kind !== "install") {
          await removeKnowledgeMcp(cli, backend, {
            name: status?.name || undefined,
            scope: status?.scope || undefined,
          }).catch(() => "");
        }
        if (kind !== "remove") await installKnowledgeMcp(cli, backend);
      });
      setJustChanged(kind !== "remove");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(slowTimer);
      setSlow(false);
      setBusy(null);
    }
  };

  // The other surface's operations must grey this row out too; the shared
  // in-flight set is the only view either surface has of the other.
  const crossBusy = useSyncExternalStore(subscribeKnowledgeMcpOps, () =>
    isKnowledgeMcpOpBusy(cli),
  );

  const remote = backend === "ssh";
  const configured = !!status?.configured;
  const mismatch =
    configured &&
    (status?.pathMatches === false ||
      (!!status?.name && status.name !== KNOWLEDGE_MCP_SERVER_NAME));
  const { label, color: dot } = knowledgeMcpStatusLabel(status);
  /** Held by an operation on EITHER surface — this row's or the sidebar's. */
  const held = !!busy || crossBusy;

  const description = slow
    ? // Says what is happening and what NOT to do. Starting a second one is the
      // failure this row exists to prevent, so the copy has to head it off.
      `${KNOWLEDGE_CLI_PRODUCT_NAME[cli]} is taking a while to answer — still running, check back in a moment. Don't start another.`
    : remote
      ? KNOWLEDGE_MCP_REMOTE_REASON
      : mismatch
        ? `Registered to a different MADE location${
            status?.registeredPath ? ` (${status.registeredPath})` : ""
          }${adapter ? ` — this one is at ${adapter}` : ""}.`
        : justChanged && configured
          ? "Takes effect in new panes."
          : undefined;

  const control = (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {error && (
        <span
          data-tooltip={error}
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 10px)",
            color: "var(--ezy-red, #e55)",
            maxWidth: 150,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {error}
        </span>
      )}
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
          color: "var(--ezy-text-secondary)",
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            backgroundColor: dot,
            flexShrink: 0,
          }}
        />
        {status === null ? "Checking…" : label}
      </span>

      {mismatch && (
        <button
          onClick={() => void run("update")}
          disabled={held}
          style={{ ...BUTTON_STYLE, cursor: held ? "default" : "pointer" }}
        >
          {busy === "update" && <Spinner />}
          {busy === "update" ? (slow ? "Still running…" : "Updating…") : "Update registration"}
        </button>
      )}

      {!configured && (
        <button
          onClick={() => void run("install")}
          disabled={held || remote}
          // A disabled control needs a reason, or the row is just dead.
          data-tooltip={remote ? KNOWLEDGE_MCP_REMOTE_REASON : undefined}
          style={{
            ...BUTTON_STYLE,
            cursor: held || remote ? "default" : "pointer",
            opacity: remote ? 0.5 : 1,
          }}
        >
          {busy === "install" && <Spinner />}
          {busy === "install" ? (slow ? "Still running…" : "Installing…") : "Install"}
        </button>
      )}

      {configured && !mismatch && (
        <button
          onClick={() => void run("remove")}
          disabled={held}
          style={{ ...BUTTON_STYLE, cursor: held ? "default" : "pointer" }}
        >
          {busy === "remove" && <Spinner />}
          {busy === "remove" ? (slow ? "Still running…" : "Removing…") : "Remove"}
        </button>
      )}
    </div>
  );

  return (
    <Row label={KNOWLEDGE_CLI_PRODUCT_NAME[cli]} description={description}>
      {control}
    </Row>
  );
}

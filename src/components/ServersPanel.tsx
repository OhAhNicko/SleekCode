import { useState, useCallback, useEffect, useRef } from "react";
import { FaTrash, FaKey, FaChevronDown } from "react-icons/fa";
import { registerSurfaceActions, unregisterSurfaceActions } from "../lib/surface-actions";
import { FaPlus, FaPencil, FaXmark, FaCheck } from "react-icons/fa6";
import { HiMiniSignal } from "react-icons/hi2";
import { BiCopy } from "react-icons/bi";
import { TbRefresh } from "react-icons/tb";
import { useAppStore } from "../store";
import type { RemoteServer } from "../types";
import { invoke } from "@tauri-apps/api/core";
import ClaudeTokenWizardModal from "./ClaudeTokenWizardModal";
import SshKeySetupWizardModal from "./SshKeySetupWizardModal";
import { detectRemoteCliShells } from "../lib/remote-cli-shells";

/* ── Types ── */

interface SshKeyInfo {
  path: string;
  name: string;
  key_type: string;
  comment: string;
}

/** Connection details the key-setup wizard needs for one server. */
interface KeyWizardTarget {
  id: string;
  name: string;
  host: string;
  username: string;
}

/* ── Small components ── */

function StatusDot({ status }: { status: "idle" | "testing" | "ok" | "error" }) {
  const color =
    status === "ok"
      ? "#4ade80"
      : status === "error"
        ? "#f87171"
        : status === "testing"
          ? "var(--ezy-text-muted)"
          : "var(--ezy-border-light)";
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        backgroundColor: color,
        flexShrink: 0,
        opacity: status === "testing" ? 0.6 : 1,
      }}
    />
  );
}

function StatusIndicator({ status }: { status: "idle" | "testing" | "ok" | "error" }) {
  const colors = {
    idle: { bg: "var(--ezy-border)", text: "var(--ezy-text-muted)" },
    testing: { bg: "var(--ezy-border)", text: "var(--ezy-text-muted)" },
    ok: { bg: "var(--ezy-accent-dim)", text: "#ffffff" },
    error: { bg: "var(--ezy-red)", text: "#ffffff" },
  };
  const labels = { idle: "Not tested", testing: "Testing...", ok: "Connected", error: "Failed" };
  const c = colors[status];

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.03em",
        backgroundColor: c.bg,
        color: c.text,
      }}
    >
      {status === "ok" && (
        <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: "var(--ezy-accent)" }} />
      )}
      {labels[status]}
    </span>
  );
}

function KeySetupButton({
  label,
  onClick,
  compact,
}: {
  label?: string;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        padding: compact ? "3px 8px" : "5px 12px",
        fontSize: compact ? 10 : 11,
        fontWeight: 600,
        color: "var(--ezy-text)",
        backgroundColor: "var(--ezy-border)",
        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
        cursor: "pointer",
        transition: "all 150ms ease",
        whiteSpace: "nowrap",
      }}
    >
      <FaKey size={compact ? 8 : 9} color="var(--ezy-text-muted)" />
      {label || "Setup SSH Key"}
    </div>
  );
}

/* ── Key Dropdown ── */

function KeyDropdown({
  keys,
  value,
  onChange,
  compact,
  onRefresh,
}: {
  keys: SshKeyInfo[];
  value: string;
  onChange: (path: string) => void;
  compact?: boolean;
  onRefresh?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = keys.find((k) => k.path === value);
  const fs = compact ? 11 : 13;

  return (
    <div ref={ref} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      {/* Trigger */}
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: compact ? "4px 8px" : "6px 10px",
          fontSize: fs,
          color: selected ? "var(--ezy-text)" : "var(--ezy-text-muted)",
          backgroundColor: "var(--ezy-bg)",
          border: `1px solid ${open ? "var(--ezy-accent-dim)" : compact ? "var(--ezy-border-light)" : "var(--ezy-border)"}`,
          borderRadius: compact ? "calc(var(--ezy-radius-scale, 1) * 4px)" : "calc(var(--ezy-radius-scale, 1) * 6px)",
          cursor: "pointer",
          fontFamily: "inherit",
          boxSizing: "border-box",
          transition: "border-color 120ms ease",
        }}
      >
        <FaKey size={compact ? 8 : 10} color="var(--ezy-text-muted)" style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected ? (
            <>
              {selected.name}
              {selected.key_type && (
                <span style={{ color: "var(--ezy-text-muted)", fontSize: fs - 2, marginLeft: 4 }}>
                  ({selected.key_type})
                </span>
              )}
            </>
          ) : (
            <span style={{ fontStyle: "italic" }}>None — generate new</span>
          )}
        </span>
        <FaChevronDown
          size={compact ? 7 : 8}
          color="var(--ezy-text-muted)"
          style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 150ms ease" }}
        />
      </div>

      {/* Popover */}
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            minWidth: compact ? 180 : undefined,
            zIndex: 50,
            backgroundColor: "var(--ezy-surface)",
            border: "1px solid var(--ezy-border-light)",
            borderRadius: compact ? "calc(var(--ezy-radius-scale, 1) * 4px)" : "calc(var(--ezy-radius-scale, 1) * 6px)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          {/* "None" option */}
          <div
            onClick={() => { onChange(""); setOpen(false); }}
            style={{
              padding: compact ? "5px 8px" : "7px 10px",
              fontSize: fs,
              color: "var(--ezy-text-muted)",
              fontStyle: "italic",
              cursor: "pointer",
              backgroundColor: !value ? "var(--ezy-accent-glow)" : "transparent",
              transition: "background-color 80ms ease",
            }}
            onMouseEnter={(e) => { if (value) e.currentTarget.style.backgroundColor = "var(--ezy-border)"; }}
            onMouseLeave={(e) => { if (value) e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            None — generate new
          </div>

          {keys.map((k) => (
            <div
              key={k.path}
              onClick={() => { onChange(k.path); setOpen(false); }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: compact ? "5px 8px" : "7px 10px",
                fontSize: fs,
                color: "var(--ezy-text)",
                cursor: "pointer",
                backgroundColor: k.path === value ? "var(--ezy-accent-glow)" : "transparent",
                borderTop: "1px solid var(--ezy-border-subtle)",
                transition: "background-color 80ms ease",
              }}
              onMouseEnter={(e) => { if (k.path !== value) e.currentTarget.style.backgroundColor = "var(--ezy-border)"; }}
              onMouseLeave={(e) => { if (k.path !== value) e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              {k.path === value && <FaCheck size={compact ? 7 : 9} color="var(--ezy-accent)" style={{ flexShrink: 0 }} />}
              <span style={{ fontWeight: 500, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {k.name}
              </span>
              {k.key_type && (
                compact ? (
                  <span style={{ color: "var(--ezy-text-muted)", fontSize: fs - 2, flexShrink: 0 }}>({k.key_type})</span>
                ) : (
                  <span style={{
                    fontSize: 10,
                    fontWeight: 600,
                    padding: "1px 5px",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                    backgroundColor: "var(--ezy-border)",
                    color: "var(--ezy-text-muted)",
                    flexShrink: 0,
                  }}>
                    {k.key_type}
                  </span>
                )
              )}
              {!compact && k.comment && (
                <span style={{ color: "var(--ezy-text-muted)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {k.comment}
                </span>
              )}
            </div>
          ))}

          {/* Refresh action at bottom */}
          {onRefresh && (
            <div
              onClick={(e) => { e.stopPropagation(); onRefresh(); }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                padding: compact ? "4px 8px" : "5px 10px",
                fontSize: compact ? 10 : 11,
                color: "var(--ezy-text-muted)",
                borderTop: "1px solid var(--ezy-border)",
                cursor: "pointer",
                transition: "background-color 80ms ease",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-border)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              <TbRefresh size={compact ? 10 : 11} />
              Refresh
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Small circled-i that carries an explanation as a hover tooltip — keeps the
 *  forms clean instead of stacking helper paragraphs under every field. */
function InfoDot({ tip, size = 11 }: { tip: string; size?: number }) {
  return (
    <span
      data-tooltip={tip}
      style={{ display: "inline-flex", alignItems: "center", cursor: "help", flexShrink: 0 }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--ezy-text-muted)"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="9" />
        <line x1="12" y1="11" x2="12" y2="16" />
        <line x1="12" y1="7.5" x2="12" y2="7.6" />
      </svg>
    </span>
  );
}

const SECURITY_TOKEN_TIP =
  "Unlocks the server's macOS login keychain when a pane connects (security unlock-keychain), so Claude stays signed in. Asks for the account password ONLY when the keychain is actually locked (usually only after a server reboot) — nothing is stored.";
const CLAUDE_TOKEN_TIP =
  "Exports a long-lived login token (from: claude setup-token) into every SSH session, bypassing the keychain. Paste one or capture it automatically.";

/* ── Inline icon button (test / copy) ── */

function SmallIconButton({
  title,
  onClick,
  disabled,
  compact,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  compact?: boolean;
  children: React.ReactNode;
}) {
  const sz = compact ? 22 : 30;
  return (
    <div
      data-tooltip={title}
      onClick={disabled ? undefined : onClick}
      style={{
        width: sz,
        height: sz,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: compact ? "calc(var(--ezy-radius-scale, 1) * 4px)" : "calc(var(--ezy-radius-scale, 1) * 6px)",
        backgroundColor: "var(--ezy-bg)",
        border: "1px solid var(--ezy-border-light)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.3 : 1,
        transition: "all 120ms ease",
        flexShrink: 0,
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.borderColor = "var(--ezy-accent-dim)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--ezy-border-light)"; }}
    >
      {children}
    </div>
  );
}

/* ── Constants ── */

const EMPTY_SERVER: Omit<RemoteServer, "id"> = {
  name: "",
  host: "",
  username: "",
  authMethod: "ssh-key",
  claudeOauthToken: "",
  claudeAuth: "keychain",
  projectsDir: "",
};

const PROJECTS_DIR_TIP =
  "Absolute path on the server where new remote projects are created (no ~). Optional — without it you pick the parent folder when creating.";

/* ── Main component ── */

export default function ServersPanel({ compact }: { compact?: boolean }) {
  const servers = useAppStore((s) => s.servers);
  const addServer = useAppStore((s) => s.addServer);
  const updateServer = useAppStore((s) => s.updateServer);
  const removeServer = useAppStore((s) => s.removeServer);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<Omit<RemoteServer, "id">>(EMPTY_SERVER);
  const [showForm, setShowForm] = useState(false);
  const [testStatus, setTestStatus] = useState<Record<string, "idle" | "testing" | "ok" | "error">>({});
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [keyWizardTarget, setKeyWizardTarget] = useState<KeyWizardTarget | null>(null);
  const [detectedKeys, setDetectedKeys] = useState<SshKeyInfo[]>([]);
  const [formKeyTestStatus, setFormKeyTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);

  // Scan ~/.ssh/ for existing key pairs
  const refreshKeys = useCallback(() => {
    invoke<SshKeyInfo[]>("ssh_list_keys").then(setDetectedKeys).catch(() => {});
  }, []);

  useEffect(() => { refreshKeys(); }, [refreshKeys]);

  const resetForm = useCallback(() => {
    setFormData(EMPTY_SERVER);
    setEditingId(null);
    setShowForm(false);
    setFormKeyTestStatus("idle");
    setShowToken(false);
  }, []);

  // Expose row handlers to the context menu. Delete deliberately routes
  // through the SAME two-click confirm the inline button uses — a menu item
  // that bypassed it would be a one-click destructive action.
  const srvRef = useRef<Record<string, (id: string) => void>>({});
  useEffect(() => {
    registerSurfaceActions("server", {
      test: (id) => srvRef.current.test?.(id),
      edit: (id) => srvRef.current.edit?.(id),
      delete: (id) => srvRef.current.delete?.(id),
      setupKey: (id) => srvRef.current.setupKey?.(id),
      copyKey: (id) => srvRef.current.copyKey?.(id),
    });
    return () => unregisterSurfaceActions("server");
  }, []);

  const handleEdit = useCallback((server: RemoteServer) => {
    setFormData({
      name: server.name,
      host: server.host,
      username: server.username,
      authMethod: server.authMethod,
      sshKeyPath: server.sshKeyPath,
      claudeOauthToken: server.claudeOauthToken ?? "",
      claudeAuth: server.claudeAuth ?? "keychain",
      projectsDir: server.projectsDir ?? "",
    });
    setEditingId(server.id);
    setShowForm(true);
    setFormKeyTestStatus("idle");
    setShowToken(false);
  }, []);

  const handleSave = useCallback(() => {
    if (!formData.name || !formData.username || !formData.host) return;

    if (editingId) {
      updateServer(editingId, formData);
    } else {
      addServer({
        id: `srv-${Date.now()}`,
        ...formData,
      });
    }
    resetForm();
  }, [formData, editingId, addServer, updateServer, resetForm]);

  const handleTestConnection = useCallback(async (server: RemoteServer) => {
    setTestStatus((s) => ({ ...s, [server.id]: "testing" }));
    try {
      const result = await invoke<boolean>("ssh_test_connection", {
        host: server.host,
        username: server.username,
        identityFile: server.authMethod === "ssh-key" && server.sshKeyPath ? server.sshKeyPath : null,
      });
      setTestStatus((s) => ({ ...s, [server.id]: result ? "ok" : "error" }));
      // Piggyback the shell/CLI probe on a successful test — this is also the
      // refresh path after installing a CLI on the server later.
      if (result) void detectRemoteCliShells(server);
    } catch {
      setTestStatus((s) => ({ ...s, [server.id]: "error" }));
    }
  }, []);

  // Auto-test every server on mount in compact mode so the Dev Servers panel shows status dots immediately.
  // Kept to mount-only to avoid hammering SSH on re-renders; user can still re-test manually.
  useEffect(() => {
    if (!compact) return;
    for (const server of servers) {
      handleTestConnection(server);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDelete = useCallback((id: string) => {
    if (deleteConfirm === id) {
      removeServer(id);
      setDeleteConfirm(null);
    } else {
      setDeleteConfirm(id);
      setTimeout(() => setDeleteConfirm(null), 3000);
    }
  }, [deleteConfirm, removeServer]);

  /** Inline test for key selected in form */
  const handleFormTest = useCallback(async () => {
    if (!formData.host || !formData.username || !formData.sshKeyPath) return;
    setFormKeyTestStatus("testing");
    try {
      const result = await invoke<boolean>("ssh_test_connection", {
        host: formData.host,
        username: formData.username,
        identityFile: formData.sshKeyPath,
      });
      setFormKeyTestStatus(result ? "ok" : "error");
      setTimeout(() => setFormKeyTestStatus("idle"), 3000);
    } catch {
      setFormKeyTestStatus("error");
      setTimeout(() => setFormKeyTestStatus("idle"), 3000);
    }
  }, [formData.host, formData.username, formData.sshKeyPath]);

  /** Copy public key to clipboard */
  const handleCopyKey = useCallback(async (keyPath: string) => {
    try {
      const content = await invoke<string>("read_file", { path: keyPath + ".pub" });
      await navigator.clipboard.writeText(content.trim());
      setCopiedKey(keyPath);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // silently fail
    }
  }, []);

  /** Open the step-by-step key setup wizard (generate → install → verify). */
  const handleSetupKey = useCallback((serverId: string, name: string, host: string, username: string) => {
    setKeyWizardTarget({ id: serverId, name, host, username });
  }, []);

  srvRef.current = {
    test: (id) => { const sv = servers.find((x) => x.id === id); if (sv) handleTestConnection(sv); },
    edit: (id) => { const sv = servers.find((x) => x.id === id); if (sv) handleEdit(sv); },
    delete: (id) => handleDelete(id),
    copyKey: (id) => { const sv = servers.find((x) => x.id === id); if (sv?.sshKeyPath) handleCopyKey(sv.sshKeyPath); },
    setupKey: (id) => {
      const sv = servers.find((x) => x.id === id);
      if (sv) handleSetupKey(sv.id, sv.name, sv.host, sv.username);
    },
  };

  /** Save (if new) then run key setup wizard directly from the form */
  const handleSetupKeyFromForm = useCallback(() => {
    if (!formData.name || !formData.username || !formData.host) return;

    let serverId: string;
    if (editingId) {
      updateServer(editingId, formData);
      serverId = editingId;
    } else {
      serverId = `srv-${Date.now()}`;
      addServer({ id: serverId, ...formData });
    }
    resetForm();
    handleSetupKey(serverId, formData.name, formData.host, formData.username);
  }, [formData, editingId, addServer, updateServer, resetForm, handleSetupKey]);

  const updateField = <K extends keyof Omit<RemoteServer, "id">>(key: K, value: Omit<RemoteServer, "id">[K]) => {
    setFormData((f) => ({ ...f, [key]: value }));
  };

  const isFormValid = formData.name && formData.username && formData.host;
  const canFormTest = !!(formData.sshKeyPath && formData.host && formData.username);
  // The token wizard SSHes in headlessly, so it needs key auth (no interactive password prompt).
  const canRunWizard = !!(formData.host && formData.username && formData.authMethod === "ssh-key" && formData.sshKeyPath);

  /** Renders the test icon for the form inline test button */
  const formTestIcon = (isCompact: boolean) => {
    const sz = isCompact ? 9 : 11;
    if (formKeyTestStatus === "testing") return <HiMiniSignal size={sz} color="var(--ezy-text-muted)" style={{ opacity: 0.5 }} />;
    if (formKeyTestStatus === "ok") return <FaCheck size={sz} color="#4ade80" />;
    if (formKeyTestStatus === "error") return <FaXmark size={sz} color="#f87171" />;
    return <HiMiniSignal size={sz} color="var(--ezy-text-muted)" />;
  };

  /** Renders copy icon with "copied" feedback */
  const copyIcon = (keyPath: string, isCompact: boolean) => {
    const sz = isCompact ? 9 : 11;
    if (copiedKey === keyPath) return <FaCheck size={sz} color="#4ade80" />;
    return <BiCopy size={sz} color="var(--ezy-text-muted)" />;
  };

  // Shared between BOTH render modes — the compact sidebar returns early, so
  // mounting these only in the full-page return would leave its buttons dead.
  const modals = (
    <>
      {setupWizardOpen && (
        <ClaudeTokenWizardModal
          server={{
            host: formData.host,
            username: formData.username,
            authMethod: formData.authMethod,
            sshKeyPath: formData.sshKeyPath,
          }}
          onToken={(token) => updateField("claudeOauthToken", token)}
          onClose={() => setSetupWizardOpen(false)}
        />
      )}
      {keyWizardTarget && (
        <SshKeySetupWizardModal
          server={keyWizardTarget}
          onComplete={(keyPath) => {
            updateServer(keyWizardTarget.id, { sshKeyPath: keyPath });
            refreshKeys();
          }}
          onClose={() => setKeyWizardTarget(null)}
        />
      )}
    </>
  );

  /* ══════════════════════════════════════════════════════
   *  COMPACT SIDEBAR MODE
   * ══════════════════════════════════════════════════════ */
  if (compact) {
    const cInputStyle: React.CSSProperties = {
      width: "100%",
      padding: "5px 8px",
      fontSize: 11,
      color: "var(--ezy-text)",
      backgroundColor: "var(--ezy-bg)",
      border: "1px solid var(--ezy-border-light)",
      borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
      outline: "none",
      fontFamily: "inherit",
      boxSizing: "border-box",
      transition: "border-color 120ms ease",
    };
    const cLabelStyle: React.CSSProperties = {
      fontSize: 9,
      fontWeight: 600,
      letterSpacing: "0.05em",
      textTransform: "uppercase",
      color: "var(--ezy-text-muted)",
      marginBottom: 3,
      display: "block",
    };
    const cLabelRowStyle: React.CSSProperties = {
      display: "flex",
      alignItems: "center",
      gap: 4,
      marginBottom: 3,
    };
    const cDividerStyle: React.CSSProperties = {
      height: 1,
      backgroundColor: "var(--ezy-border-subtle)",
      margin: "2px 0",
    };
    const cSegmentWrapStyle: React.CSSProperties = {
      display: "flex",
      gap: 1,
      backgroundColor: "var(--ezy-bg)",
      border: "1px solid var(--ezy-border-subtle)",
      borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
      padding: 1,
    };
    // Inline-style :focus — accent the active input's border like the app's
    // dropdown triggers do on open.
    const focusIn = (e: React.FocusEvent<HTMLInputElement>) => {
      e.currentTarget.style.borderColor = "var(--ezy-accent-dim)";
    };
    const focusOut = (e: React.FocusEvent<HTMLInputElement>) => {
      e.currentTarget.style.borderColor = "var(--ezy-border-light)";
    };

    return (
      <div style={{ display: "flex", flexDirection: "column" }}>
        {/* Compact section header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "6px 10px",
            borderBottom: "1px solid var(--ezy-border-subtle)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--ezy-text-muted)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
              Remote
            </span>
            {servers.length > 0 && (
              <span style={{ fontSize: 10, color: "var(--ezy-text-muted)", opacity: 0.6 }}>
                {servers.length}
              </span>
            )}
          </div>
          <div
            data-tooltip="Add remote server"
            style={{
              width: 18,
              height: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
              cursor: "pointer",
              transition: "background-color 120ms ease",
            }}
            onClick={() => { resetForm(); setShowForm(!showForm); }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            {showForm ? (
              <FaXmark size={9} color="var(--ezy-text-muted)" />
            ) : (
              <FaPlus size={9} color="var(--ezy-text-muted)" />
            )}
          </div>
        </div>

        {/* Compact add/edit form — a rounded card with a title strip, grouped
            sections and a hairline divider before the Claude sign-in block. */}
        {showForm && (
          <div style={{ padding: 8, borderBottom: "1px solid var(--ezy-border-subtle)" }}>
            <div
              style={{
                border: "1px solid var(--ezy-border-subtle)",
                borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
                overflow: "hidden",
                backgroundColor: "var(--ezy-surface)",
              }}
            >
              {/* Title strip */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 10px",
                  borderBottom: "1px solid var(--ezy-border-subtle)",
                }}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-accent)" strokeWidth="1.5">
                  <rect x="2" y="1" width="12" height="6" rx="1.5" />
                  <rect x="2" y="9" width="12" height="6" rx="1.5" />
                  <circle cx="5" cy="4" r="1" fill="var(--ezy-accent)" stroke="none" />
                  <circle cx="5" cy="12" r="1" fill="var(--ezy-accent)" stroke="none" />
                </svg>
                <span
                  style={{
                    flex: 1,
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--ezy-text)",
                  }}
                >
                  {editingId ? "Edit Server" : "Add Server"}
                </span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="var(--ezy-text-muted)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  style={{ cursor: "pointer", flexShrink: 0 }}
                  data-tooltip="Cancel"
                  onClick={resetForm}
                >
                  <line x1="4" y1="4" x2="12" y2="12" />
                  <line x1="12" y1="4" x2="4" y2="12" />
                </svg>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10 }}>
              {/* Name + Username side by side */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <div>
                  <label style={cLabelStyle}>Name</label>
                  <input style={cInputStyle} onFocus={focusIn} onBlur={focusOut} placeholder="My server" value={formData.name} onChange={(e) => updateField("name", e.target.value)} />
                </div>
                <div>
                  <label style={cLabelStyle}>Username</label>
                  <input style={cInputStyle} onFocus={focusIn} onBlur={focusOut} placeholder="user" value={formData.username} onChange={(e) => updateField("username", e.target.value)} />
                </div>
              </div>

              {/* Host — single field */}
              <div>
                <label style={cLabelStyle}>Host</label>
                <input
                  style={cInputStyle}
                  onFocus={focusIn}
                  onBlur={focusOut}
                  placeholder="hostname or IP"
                  value={formData.host}
                  onChange={(e) => updateField("host", e.target.value)}
                />
              </div>

              {/* Where new remote projects land on this server */}
              <div>
                <div style={cLabelRowStyle}>
                  <label style={{ ...cLabelStyle, marginBottom: 0 }}>Projects dir</label>
                  <InfoDot size={10} tip={PROJECTS_DIR_TIP} />
                </div>
                <input
                  style={cInputStyle}
                  onFocus={focusIn}
                  onBlur={focusOut}
                  placeholder="/home/user/projects"
                  value={formData.projectsDir || ""}
                  onChange={(e) => updateField("projectsDir", e.target.value)}
                />
              </div>

              {/* Auth method toggle */}
              <div>
                <label style={cLabelStyle}>Auth</label>
                <div style={cSegmentWrapStyle}>
                  {(["ssh-key", "password"] as const).map((method) => (
                    <div
                      key={method}
                      onClick={() => {
                        updateField("authMethod", method);
                        if (method === "password") updateField("sshKeyPath", undefined as unknown as string);
                      }}
                      style={{
                        flex: 1,
                        padding: "4px 0",
                        fontSize: 10,
                        fontWeight: 600,
                        textAlign: "center",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                        cursor: "pointer",
                        color: formData.authMethod === method ? "#fff" : "var(--ezy-text-muted)",
                        backgroundColor: formData.authMethod === method ? "var(--ezy-accent-dim)" : "transparent",
                        transition: "all 120ms ease",
                      }}
                    >
                      {method === "ssh-key" ? "SSH Key" : "Password"}
                    </div>
                  ))}
                </div>
              </div>

              {/* Key picker or password hint */}
              {formData.authMethod === "ssh-key" ? (
                <div>
                  <label style={cLabelStyle}>Existing Key</label>
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <KeyDropdown
                      compact
                      keys={detectedKeys}
                      value={formData.sshKeyPath || ""}
                      onChange={(p) => { updateField("sshKeyPath", p || undefined as unknown as string); setFormKeyTestStatus("idle"); }}
                      onRefresh={refreshKeys}
                    />
                    {formData.sshKeyPath && (
                      <>
                        <SmallIconButton
                          compact
                          title={canFormTest ? "Test connection with this key" : "Fill host and username first"}
                          onClick={handleFormTest}
                          disabled={!canFormTest || formKeyTestStatus === "testing"}
                        >
                          {formTestIcon(true)}
                        </SmallIconButton>
                        <SmallIconButton
                          compact
                          title={copiedKey === formData.sshKeyPath ? "Copied!" : "Copy public key"}
                          onClick={() => handleCopyKey(formData.sshKeyPath!)}
                        >
                          {copyIcon(formData.sshKeyPath, true)}
                        </SmallIconButton>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 10, color: "var(--ezy-text-muted)", fontStyle: "italic", paddingTop: 1 }}>
                  Password prompted on connect
                </div>
              )}

              <div style={cDividerStyle} />

              {/* Claude sign-in — how Claude Code stays logged in over SSH.
                  Explanations live in hover tooltips (InfoDot + per-option
                  data-tooltip) to keep the sidebar clean. */}
              <div>
                <div style={cLabelRowStyle}>
                  <label style={{ ...cLabelStyle, marginBottom: 0 }}>Claude sign-in</label>
                  <InfoDot
                    size={10}
                    tip={(formData.claudeAuth ?? "keychain") === "keychain" ? SECURITY_TOKEN_TIP : CLAUDE_TOKEN_TIP}
                  />
                </div>
                <div style={cSegmentWrapStyle}>
                  {(["keychain", "token"] as const).map((mode) => (
                    <div
                      key={mode}
                      onClick={() => updateField("claudeAuth", mode)}
                      data-tooltip={mode === "keychain" ? SECURITY_TOKEN_TIP : CLAUDE_TOKEN_TIP}
                      style={{
                        flex: 1,
                        padding: "4px 0",
                        fontSize: 10,
                        fontWeight: 600,
                        textAlign: "center",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        color: (formData.claudeAuth ?? "keychain") === mode ? "#fff" : "var(--ezy-text-muted)",
                        backgroundColor: (formData.claudeAuth ?? "keychain") === mode ? "var(--ezy-accent-dim)" : "transparent",
                        transition: "all 120ms ease",
                      }}
                    >
                      {mode === "keychain" ? "Security token" : "Claude login token"}
                    </div>
                  ))}
                </div>
                {(formData.claudeAuth ?? "keychain") === "token" && (
                  <>
                    <div style={{ display: "flex", gap: 4, alignItems: "center", marginTop: 6 }}>
                      <input
                        style={cInputStyle}
                        onFocus={focusIn}
                        onBlur={focusOut}
                        type={showToken ? "text" : "password"}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="sk-ant-oat…"
                        value={formData.claudeOauthToken || ""}
                        onChange={(e) => updateField("claudeOauthToken", e.target.value)}
                      />
                      <SmallIconButton
                        compact
                        title={showToken ? "Hide token" : "Show token"}
                        onClick={() => setShowToken((v) => !v)}
                      >
                        {showToken ? (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                          </svg>
                        ) : (
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        )}
                      </SmallIconButton>
                    </div>
                    <div
                      onClick={canRunWizard ? () => setSetupWizardOpen(true) : undefined}
                      data-tooltip={canRunWizard ? "Run claude setup-token over SSH and capture the token" : "Requires an SSH-key server with host, username and key set"}
                      style={{
                        marginTop: 6,
                        padding: "4px 0",
                        fontSize: 11,
                        fontWeight: 600,
                        textAlign: "center",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                        border: "1px solid var(--ezy-border-light)",
                        color: canRunWizard ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                        backgroundColor: "var(--ezy-bg)",
                        cursor: canRunWizard ? "pointer" : "default",
                        opacity: canRunWizard ? 1 : 0.5,
                        transition: "all 120ms ease",
                      }}
                    >
                      Set up automatically
                    </div>
                  </>
                )}
              </div>

              {/* Footer actions — Cancel lives as the ✕ in the title strip. */}
              <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                <div
                  onClick={handleSave}
                  style={{
                    flex: 1,
                    padding: "5px 0",
                    fontSize: 11,
                    fontWeight: 600,
                    color: isFormValid ? "#fff" : "var(--ezy-text-muted)",
                    backgroundColor: isFormValid ? "var(--ezy-accent)" : "var(--ezy-border)",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                    cursor: isFormValid ? "pointer" : "default",
                    textAlign: "center",
                    opacity: isFormValid ? 1 : 0.5,
                    transition: "background-color 120ms ease",
                  }}
                >
                  {editingId ? "Update" : "Add"}
                </div>
                {formData.authMethod === "ssh-key" && (
                  <div
                    onClick={isFormValid ? handleSetupKeyFromForm : undefined}
                    data-tooltip="Generate a key and install it on the server (guided)"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 4,
                      flex: 1,
                      padding: "5px 0",
                      fontSize: 11,
                      fontWeight: 600,
                      color: isFormValid ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                      backgroundColor: "transparent",
                      border: "1px solid var(--ezy-border-light)",
                      borderRadius: "calc(var(--ezy-radius-scale, 1) * 5px)",
                      cursor: isFormValid ? "pointer" : "default",
                      opacity: isFormValid ? 1 : 0.4,
                      transition: "all 120ms ease",
                    }}
                    onMouseEnter={(e) => { if (isFormValid) e.currentTarget.style.borderColor = "var(--ezy-accent-dim)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--ezy-border-light)"; }}
                  >
                    <FaKey size={8} />
                    New Key
                  </div>
                )}
              </div>
              </div>
            </div>
          </div>
        )}

        {/* Compact server list */}
        {servers.length === 0 && !showForm ? (
          <div style={{ padding: "12px 10px", textAlign: "center", color: "var(--ezy-text-muted)" }}>
            <p style={{ fontSize: 11, margin: 0 }}>No remote servers</p>
            <p style={{ fontSize: 10, margin: "2px 0 0", color: "var(--ezy-border-light)" }}>
              Click + to add one
            </p>
          </div>
        ) : (
          servers.map((server) => {
            const status = testStatus[server.id] ?? "idle";
            const hasKey = !!server.sshKeyPath;

            return (
              <div
                key={server.id}
                data-ctx-surface="server"
                data-ctx-id={server.id}
                data-ctx-label={server.name}
                data-ctx-host={server.host}
                data-ctx-user={server.username}
                data-ctx-has-key={hasKey ? "1" : ""}
                style={{ borderBottom: "1px solid var(--ezy-border-subtle)" }}
              >
                {/* Row 1: status dot + name + actions */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px 1px" }}>
                  <StatusDot status={status} />
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: "var(--ezy-text)",
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {server.name}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
                    <div
                      data-tooltip="Test Connection"
                      onClick={() => handleTestConnection(server)}
                      style={{
                        width: 20, height: 20,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)", cursor: status === "testing" ? "default" : "pointer",
                        transition: "background-color 120ms ease",
                        opacity: status === "testing" ? 0.4 : 1,
                      }}
                      onMouseEnter={(e) => { if (status !== "testing") e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                    >
                      <HiMiniSignal size={11} color="var(--ezy-text-muted)" />
                    </div>
                    <div
                     
                      onClick={() => handleEdit(server)}
                      style={{
                        width: 20, height: 20,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)", cursor: "pointer",
                        transition: "background-color 120ms ease",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                    >
                      <FaPencil size={9} color="var(--ezy-text-muted)" />
                    </div>
                    <div
                      data-tooltip={deleteConfirm === server.id ? "Click again to confirm" : "Delete"}
                      onClick={() => handleDelete(server.id)}
                      style={{
                        width: 20, height: 20,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)", cursor: "pointer",
                        transition: "background-color 120ms ease",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "rgba(220,60,60,0.15)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                    >
                      <FaTrash size={9} color={deleteConfirm === server.id ? "var(--ezy-red)" : "var(--ezy-text-muted)"} />
                    </div>
                  </div>
                </div>

                {/* Row 2: host + user */}
                <div style={{ padding: "0 10px 2px 22px", fontSize: 11, color: "var(--ezy-text-muted)" }}>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{server.host}</span>
                  <span style={{ margin: "0 5px", opacity: 0.3 }}>/</span>
                  <span>{server.username}</span>
                </div>

                {/* Row 3: SSH key setup (if no key yet) */}
                {!hasKey && server.authMethod === "ssh-key" && (
                  <div style={{ padding: "2px 10px 5px 22px" }}>
                    <KeySetupButton
                      compact
                      onClick={() => handleSetupKey(server.id, server.name, server.host, server.username)}
                    />
                  </div>
                )}
                {hasKey && (
                  <div style={{ padding: "0 10px 5px 22px", fontSize: 10, color: "var(--ezy-accent)", display: "flex", alignItems: "center", gap: 4 }}>
                    <FaKey size={7} />
                    <span style={{ opacity: 0.8 }}>Key configured</span>
                    <div
                      data-tooltip={copiedKey === server.sshKeyPath ? "Copied!" : "Copy public key"}
                      onClick={() => handleCopyKey(server.sshKeyPath!)}
                      // Same hover as this sidebar's other icon buttons (test /
                      // edit / delete above). 14px, not the 22px SmallIconButton
                      // chip: this sits in a 10px text row, and a taller hit box
                      // would grow the row — see the compact-header note in
                      // CLAUDE.md.
                      style={{
                        width: 14,
                        height: 14,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        marginLeft: 2,
                        flexShrink: 0,
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                        cursor: "pointer",
                        transition: "background-color 120ms ease",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                    >
                      {copiedKey === server.sshKeyPath ? (
                        <FaCheck size={7} color="#4ade80" />
                      ) : (
                        <BiCopy size={9} color="var(--ezy-text-muted)" style={{ opacity: 0.7 }} />
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
        {modals}
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════
   *  FULL-PAGE MODE
   * ══════════════════════════════════════════════════════ */
  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "6px 10px",
    backgroundColor: "var(--ezy-bg)",
    border: "1px solid var(--ezy-border)",
    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
    color: "var(--ezy-text)",
    fontSize: 13,
    fontFamily: "inherit",
    outline: "none",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--ezy-text-muted)",
    letterSpacing: "0.04em",
    marginBottom: 4,
    display: "block",
  };

  return (
    <div
      className="h-full w-full flex flex-col workspace-enter"
      style={{ backgroundColor: "var(--ezy-bg)" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between select-none"
        style={{
          height: 48,
          padding: "0 20px",
          borderBottom: "1px solid var(--ezy-border)",
          backgroundColor: "var(--ezy-surface)",
        }}
      >
        <div className="flex items-center gap-3">
          <svg
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-cyan)"
            strokeWidth="1.3"
          >
            <rect x="2" y="1" width="12" height="6" rx="1.5" />
            <rect x="2" y="9" width="12" height="6" rx="1.5" />
            <circle cx="5" cy="4" r="1" fill="var(--ezy-cyan)" stroke="none" />
            <circle cx="5" cy="12" r="1" fill="var(--ezy-cyan)" stroke="none" />
            <line x1="8" y1="4" x2="12" y2="4" strokeLinecap="round" />
            <line x1="8" y1="12" x2="12" y2="12" strokeLinecap="round" />
          </svg>
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--ezy-text)",
              letterSpacing: "0.02em",
            }}
          >
            Remote Servers
          </span>
          <span style={{ fontSize: 12, color: "var(--ezy-text-muted)" }}>
            {servers.length} configured
          </span>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(true); }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 12px",
            backgroundColor: "var(--ezy-accent-dim)",
            border: "none",
            borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
            color: "#ffffff",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <FaPlus size={12} color="#ffffff" />
          Add Server
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto" style={{ padding: 20 }}>
        {/* Add/Edit form */}
        {showForm && (
          <div
            style={{
              border: "1px solid var(--ezy-border)",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
              padding: 16,
              marginBottom: 16,
              backgroundColor: "var(--ezy-surface)",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)", marginBottom: 12 }}>
              {editingId ? "Edit Server" : "Add Server"}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div>
                <label style={labelStyle}>Name</label>
                <input
                  style={inputStyle}
                  placeholder="My server"
                  value={formData.name}
                  onChange={(e) => updateField("name", e.target.value)}
                />
              </div>
              <div>
                <label style={labelStyle}>Host</label>
                <input
                  style={inputStyle}
                  placeholder="hostname or IP"
                  value={formData.host}
                  onChange={(e) => updateField("host", e.target.value)}
                />
              </div>
              <div>
                <label style={labelStyle}>Username</label>
                <input
                  style={inputStyle}
                  placeholder="user"
                  value={formData.username}
                  onChange={(e) => updateField("username", e.target.value)}
                />
              </div>
            </div>

            {/* Where new remote projects land on this server */}
            <div style={{ marginBottom: 12, maxWidth: 420 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
                <label style={{ ...labelStyle, marginBottom: 0 }}>Projects Directory</label>
                <InfoDot tip={PROJECTS_DIR_TIP} />
              </div>
              <input
                style={inputStyle}
                placeholder="/home/user/projects"
                value={formData.projectsDir || ""}
                onChange={(e) => updateField("projectsDir", e.target.value)}
              />
            </div>

            {/* Auth method + key picker row */}
            <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "flex-end" }}>
              <div>
                <label style={labelStyle}>Auth Method</label>
                <div style={{ display: "flex", gap: 1, backgroundColor: "var(--ezy-bg)", borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)", padding: 2 }}>
                  {(["ssh-key", "password"] as const).map((method) => (
                    <div
                      key={method}
                      onClick={() => {
                        updateField("authMethod", method);
                        if (method === "password") updateField("sshKeyPath", undefined as unknown as string);
                      }}
                      style={{
                        padding: "5px 14px",
                        fontSize: 12,
                        fontWeight: 600,
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                        cursor: "pointer",
                        color: formData.authMethod === method ? "#fff" : "var(--ezy-text-muted)",
                        backgroundColor: formData.authMethod === method ? "var(--ezy-accent-dim)" : "transparent",
                        transition: "all 120ms ease",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {method === "ssh-key" ? "SSH Key" : "Password"}
                    </div>
                  ))}
                </div>
              </div>

              {formData.authMethod === "ssh-key" ? (
                <>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                    <label style={labelStyle}>Existing Key</label>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <KeyDropdown
                        keys={detectedKeys}
                        value={formData.sshKeyPath || ""}
                        onChange={(p) => { updateField("sshKeyPath", p || undefined as unknown as string); setFormKeyTestStatus("idle"); }}
                        onRefresh={refreshKeys}
                      />
                      {formData.sshKeyPath && (
                        <>
                          <SmallIconButton
                            title={canFormTest ? "Test connection with this key" : "Fill host and username first"}
                            onClick={handleFormTest}
                            disabled={!canFormTest || formKeyTestStatus === "testing"}
                          >
                            {formTestIcon(false)}
                          </SmallIconButton>
                          <SmallIconButton
                            title={copiedKey === formData.sshKeyPath ? "Copied!" : "Copy public key"}
                            onClick={() => handleCopyKey(formData.sshKeyPath!)}
                          >
                            {copyIcon(formData.sshKeyPath, false)}
                          </SmallIconButton>
                        </>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ flex: 1, display: "flex", alignItems: "flex-end", paddingBottom: 4 }}>
                  <span style={{ fontSize: 12, color: "var(--ezy-text-muted)", fontStyle: "italic" }}>
                    Password prompted on connect
                  </span>
                </div>
              )}
            </div>

            {/* Claude sign-in — how Claude Code stays logged in over SSH.
                Explanations live in hover tooltips, keeping the form clean. */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
                <label style={{ ...labelStyle, marginBottom: 0 }}>Claude Sign-in</label>
                <InfoDot
                  tip={(formData.claudeAuth ?? "keychain") === "keychain" ? SECURITY_TOKEN_TIP : CLAUDE_TOKEN_TIP}
                />
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div style={{ display: "flex", gap: 1, backgroundColor: "var(--ezy-bg)", borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)", padding: 2, flexShrink: 0 }}>
                  {(["keychain", "token"] as const).map((mode) => (
                    <div
                      key={mode}
                      onClick={() => updateField("claudeAuth", mode)}
                      data-tooltip={mode === "keychain" ? SECURITY_TOKEN_TIP : CLAUDE_TOKEN_TIP}
                      style={{
                        padding: "5px 14px",
                        fontSize: 12,
                        fontWeight: 600,
                        borderRadius: "calc(var(--ezy-radius-scale, 1) * 4px)",
                        cursor: "pointer",
                        color: (formData.claudeAuth ?? "keychain") === mode ? "#fff" : "var(--ezy-text-muted)",
                        backgroundColor: (formData.claudeAuth ?? "keychain") === mode ? "var(--ezy-accent-dim)" : "transparent",
                        transition: "all 120ms ease",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {mode === "keychain" ? "Security token" : "Claude login token"}
                    </div>
                  ))}
                </div>
                {(formData.claudeAuth ?? "keychain") === "token" && (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        style={inputStyle}
                        type={showToken ? "text" : "password"}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="sk-ant-oat…"
                        value={formData.claudeOauthToken || ""}
                        onChange={(e) => updateField("claudeOauthToken", e.target.value)}
                      />
                      <SmallIconButton
                        title={showToken ? "Hide token" : "Show token"}
                        onClick={() => setShowToken((v) => !v)}
                      >
                        {showToken ? (
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                          </svg>
                        ) : (
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ezy-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        )}
                      </SmallIconButton>
                      <button
                        onClick={canRunWizard ? () => setSetupWizardOpen(true) : undefined}
                        data-tooltip={canRunWizard ? "Run claude setup-token over SSH and capture the token" : "Requires an SSH-key server with host, username and key set"}
                        disabled={!canRunWizard}
                        style={{
                          padding: "6px 12px",
                          fontSize: 12,
                          fontWeight: 600,
                          borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                          border: "1px solid var(--ezy-border-light)",
                          color: canRunWizard ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                          backgroundColor: "var(--ezy-bg)",
                          cursor: canRunWizard ? "pointer" : "default",
                          opacity: canRunWizard ? 1 : 0.5,
                          fontFamily: "inherit",
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                        }}
                      >
                        Set up automatically
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={!isFormValid}
                style={{
                  padding: "6px 16px",
                  backgroundColor: "var(--ezy-accent-dim)",
                  border: "none",
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                  color: "#ffffff",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  opacity: !isFormValid ? 0.5 : 1,
                }}
              >
                {editingId ? "Update" : "Add"}
              </button>
              {formData.authMethod === "ssh-key" && (
                <button
                  onClick={handleSetupKeyFromForm}
                  disabled={!isFormValid}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "6px 16px",
                    backgroundColor: "var(--ezy-border)",
                    border: "none",
                    borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                    color: "var(--ezy-text)",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    opacity: !isFormValid ? 0.5 : 1,
                  }}
                >
                  <FaKey size={10} />
                  Generate New Key
                </button>
              )}
              <button
                onClick={resetForm}
                style={{
                  padding: "6px 16px",
                  backgroundColor: "transparent",
                  border: "1px solid var(--ezy-border)",
                  borderRadius: "calc(var(--ezy-radius-scale, 1) * 6px)",
                  color: "var(--ezy-text-muted)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Server list */}
        {servers.length === 0 && !showForm ? (
          <div
            className="flex flex-col items-center justify-center h-full"
            style={{ color: "var(--ezy-text-muted)" }}
          >
            <svg
              width="48"
              height="48"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--ezy-border)"
              strokeWidth="0.8"
              style={{ marginBottom: 16 }}
            >
              <rect x="2" y="1" width="12" height="6" rx="1.5" />
              <rect x="2" y="9" width="12" height="6" rx="1.5" />
              <circle cx="5" cy="4" r="1" fill="var(--ezy-border)" stroke="none" />
              <circle cx="5" cy="12" r="1" fill="var(--ezy-border)" stroke="none" />
            </svg>
            <p style={{ fontSize: 14, marginBottom: 4 }}>
              No remote servers configured
            </p>
            <p style={{ fontSize: 12, color: "var(--ezy-border-light)" }}>
              Add a server to SSH into remote machines from MADE
            </p>
          </div>
        ) : servers.length > 0 && (
          <div
            style={{
              border: "1px solid var(--ezy-border)",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 8px)",
              overflow: "hidden",
            }}
          >
            {/* Table header */}
            <div
              className="grid select-none"
              style={{
                gridTemplateColumns: "1fr 140px 100px 120px 160px",
                backgroundColor: "var(--ezy-surface)",
                borderBottom: "1px solid var(--ezy-border)",
                padding: "8px 16px",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--ezy-text-muted)",
              }}
            >
              <span>Name</span>
              <span>Host</span>
              <span>User</span>
              <span>Status</span>
              <span style={{ textAlign: "right" }}>Actions</span>
            </div>

            {/* Table rows */}
            {servers.map((server) => {
              const status = testStatus[server.id] ?? "idle";
              const hasKey = !!server.sshKeyPath;

              return (
                <div
                  key={server.id}
                  style={{
                    borderBottom: "1px solid var(--ezy-border-subtle)",
                  }}
                >
                  <div
                    className="grid items-center"
                    style={{
                      gridTemplateColumns: "1fr 140px 100px 120px 160px",
                      padding: "10px 16px",
                      fontSize: 13,
                      color: "var(--ezy-text)",
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="var(--ezy-cyan)" strokeWidth="1.3">
                        <rect x="2" y="1" width="12" height="6" rx="1.5" />
                        <rect x="2" y="9" width="12" height="6" rx="1.5" />
                        <circle cx="5" cy="4" r="1" fill="var(--ezy-cyan)" stroke="none" />
                        <circle cx="5" cy="12" r="1" fill="var(--ezy-cyan)" stroke="none" />
                      </svg>
                      <span style={{ fontWeight: 500 }}>{server.name}</span>
                      {hasKey && (
                        <>
                          <FaKey size={9} color="var(--ezy-accent)" style={{ opacity: 0.6 }} title="SSH key configured" />
                          <div
                            data-tooltip={copiedKey === server.sshKeyPath ? "Copied!" : "Copy public key"}
                            onClick={() => handleCopyKey(server.sshKeyPath!)}
                            // Twin of the sidebar copy button — same defect, same
                            // fix, one size up for this row's larger icon.
                            style={{
                              width: 16,
                              height: 16,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                              borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
                              cursor: "pointer",
                              transition: "background-color 120ms ease",
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                          >
                            {copiedKey === server.sshKeyPath ? (
                              <FaCheck size={9} color="#4ade80" />
                            ) : (
                              <BiCopy size={11} color="var(--ezy-text-muted)" style={{ opacity: 0.5 }} />
                            )}
                          </div>
                        </>
                      )}
                    </div>
                    <span style={{ color: "var(--ezy-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                      {server.host}
                    </span>
                    <span style={{ color: "var(--ezy-text-muted)" }}>{server.username}</span>
                    <StatusIndicator status={status} />
                    <div className="flex items-center justify-end gap-1">
                      {!hasKey && server.authMethod === "ssh-key" && (
                        <KeySetupButton
                          label="Setup Key"
                          onClick={() => handleSetupKey(server.id, server.name, server.host, server.username)}
                        />
                      )}
                      <button
                        onClick={() => handleTestConnection(server)}
                        data-tooltip="Test Connection" aria-label="Test Connection"
                        className="p-1.5 rounded transition-colors"
                        disabled={status === "testing"}
                        style={{ backgroundColor: "transparent" }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                      >
                        <HiMiniSignal size={14} color="var(--ezy-text-muted)" />
                      </button>
                      <button
                        onClick={() => handleEdit(server)}
                        aria-label="Edit"
                        className="p-1.5 rounded transition-colors"
                        style={{ backgroundColor: "transparent" }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                      >
                        <FaPencil size={13} color="var(--ezy-text-muted)" />
                      </button>
                      <button
                        onClick={() => handleDelete(server.id)}
                        data-tooltip={deleteConfirm === server.id ? "Click again to confirm" : "Delete"} aria-label={deleteConfirm === server.id ? "Click again to confirm" : "Delete"}
                        className="p-1.5 rounded transition-colors group"
                      >
                        <FaTrash
                          size={13}
                          color={deleteConfirm === server.id ? "var(--ezy-red)" : "var(--ezy-text-muted)"}
                          className="group-hover:text-[var(--ezy-red)]"
                        />
                      </button>
                    </div>
                  </div>

                </div>
              );
            })}
          </div>
        )}
      </div>

      {modals}
    </div>
  );
}

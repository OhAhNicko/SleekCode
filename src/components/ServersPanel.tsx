import { useState, useCallback, useEffect, useRef } from "react";
import { FaTrash, FaKey, FaChevronDown } from "react-icons/fa";
import { FaPlus, FaPencil, FaXmark, FaCheck } from "react-icons/fa6";
import { HiMiniSignal } from "react-icons/hi2";
import { BiCopy } from "react-icons/bi";
import { TbRefresh } from "react-icons/tb";
import { useAppStore } from "../store";
import type { RemoteServer } from "../types";
import { invoke } from "@tauri-apps/api/core";

/* ── Types ── */

interface SshKeyInfo {
  path: string;
  name: string;
  key_type: string;
  comment: string;
}

/* ── Helpers ── */

/** Compute a deterministic SSH key path from server name + short ID suffix */
function getKeyPath(serverName: string, serverId: string): string {
  const sanitized = serverName.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const suffix = serverId.replace("srv-", "").slice(-6);
  return `~/.ssh/ezydev_${sanitized}_${suffix}_ed25519`;
}

type KeySetupStatus = "idle" | "checking" | "generating" | "installing" | "testing" | "done" | "error";

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
        borderRadius: 4,
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
  status,
  label,
  onClick,
  compact,
}: {
  status: KeySetupStatus;
  label?: string;
  onClick: () => void;
  compact?: boolean;
}) {
  const isWorking = status === "checking" || status === "generating" || status === "installing" || status === "testing";
  const isDone = status === "done";
  const isError = status === "error";

  const statusLabels: Record<KeySetupStatus, string> = {
    idle: label || "Setup SSH Key",
    checking: "Checking...",
    generating: "Generating key...",
    installing: "Installing...",
    testing: "Verifying...",
    done: "Key installed",
    error: "Failed — retry?",
  };

  const bg = isDone
    ? "var(--ezy-accent-dim)"
    : isError
      ? "var(--ezy-red)"
      : "var(--ezy-border)";

  const fg = isDone || isError ? "#fff" : "var(--ezy-text)";

  return (
    <div
      onClick={isWorking ? undefined : onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        padding: compact ? "3px 8px" : "5px 12px",
        fontSize: compact ? 10 : 11,
        fontWeight: 600,
        color: fg,
        backgroundColor: bg,
        borderRadius: 4,
        cursor: isWorking ? "default" : "pointer",
        opacity: isWorking ? 0.7 : 1,
        transition: "all 150ms ease",
        whiteSpace: "nowrap",
      }}
    >
      {isDone ? (
        <FaCheck size={compact ? 8 : 9} />
      ) : (
        <FaKey size={compact ? 8 : 9} color={isError ? "#fff" : "var(--ezy-text-muted)"} />
      )}
      {statusLabels[status]}
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
          borderRadius: compact ? 4 : 6,
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
            borderRadius: compact ? 4 : 6,
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
                    borderRadius: 3,
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
      title={title}
      onClick={disabled ? undefined : onClick}
      style={{
        width: sz,
        height: sz,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: compact ? 4 : 6,
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
};

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
  const [keySetupStatus, setKeySetupStatus] = useState<Record<string, KeySetupStatus>>({});
  const [keySetupError, setKeySetupError] = useState<Record<string, string>>({});
  const [detectedKeys, setDetectedKeys] = useState<SshKeyInfo[]>([]);
  const [formKeyTestStatus, setFormKeyTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

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
  }, []);

  const handleEdit = useCallback((server: RemoteServer) => {
    setFormData({
      name: server.name,
      host: server.host,
      username: server.username,
      authMethod: server.authMethod,
      sshKeyPath: server.sshKeyPath,
    });
    setEditingId(server.id);
    setShowForm(true);
    setFormKeyTestStatus("idle");
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
    } catch {
      setTestStatus((s) => ({ ...s, [server.id]: "error" }));
    }
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

  /** SSH key generation + installation wizard */
  const handleSetupKey = useCallback(async (serverId: string, name: string, host: string, username: string) => {
    const keyPath = getKeyPath(name, serverId);
    setKeySetupError((s) => ({ ...s, [serverId]: "" }));

    try {
      // Step 1: Check if key exists
      setKeySetupStatus((s) => ({ ...s, [serverId]: "checking" }));
      const exists = await invoke<boolean>("ssh_check_key", { keyPath });

      // Step 2: Generate if needed
      if (!exists) {
        setKeySetupStatus((s) => ({ ...s, [serverId]: "generating" }));
        await invoke<string>("ssh_keygen", { keyPath });
      }

      // Step 3: Install on remote via a PTY terminal
      setKeySetupStatus((s) => ({ ...s, [serverId]: "installing" }));

      // Build the install command — use manual method since Windows may not have ssh-copy-id
      const pubKeyPath = `${keyPath}.pub`;
      const installCmd = `cat ${pubKeyPath} | ssh -o StrictHostKeyChecking=no ${username}@${host} "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"`;

      // Spawn a temporary terminal for the user to type their password
      const { generateTerminalId } = await import("../lib/layout-utils");
      const terminalId = generateTerminalId();
      const store = useAppStore.getState();
      store.addTerminal(terminalId, "shell", "");

      // Find or create a tab to host this temporary terminal
      const activeTab = store.tabs.find((t) => t.id === store.activeTabId);
      if (activeTab && !activeTab.isDevServerTab && !activeTab.isServersTab && !activeTab.isKanbanTab) {
        const { splitPane, findFirstLeafId } = await import("../lib/layout-utils");
        const leafId = findFirstLeafId(activeTab.layout);
        if (leafId) {
          const newLayout = splitPane(activeTab.layout, leafId, "horizontal", {
            type: "terminal",
            id: `pane-sshsetup-${Date.now()}`,
            terminalId,
          });
          store.updateTabLayout(activeTab.id, newLayout);
        }
      }

      // Write the install command to the terminal after a short delay for shell init
      setTimeout(async () => {
        const { getPtyWrite } = await import("../store/terminalSlice");
        const write = getPtyWrite(terminalId);
        if (write) {
          write(installCmd + "\r");
        }
      }, 1500);

      // Auto-save the key path and refresh key list
      updateServer(serverId, { sshKeyPath: keyPath });
      setKeySetupStatus((s) => ({ ...s, [serverId]: "done" }));
      refreshKeys();

    } catch (e) {
      setKeySetupError((s) => ({ ...s, [serverId]: String(e) }));
      setKeySetupStatus((s) => ({ ...s, [serverId]: "error" }));
    }
  }, [updateServer, refreshKeys]);

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

  /* ══════════════════════════════════════════════════════
   *  COMPACT SIDEBAR MODE
   * ══════════════════════════════════════════════════════ */
  if (compact) {
    const cInputStyle: React.CSSProperties = {
      width: "100%",
      padding: "4px 8px",
      fontSize: 11,
      color: "var(--ezy-text)",
      backgroundColor: "var(--ezy-bg)",
      border: "1px solid var(--ezy-border-light)",
      borderRadius: 4,
      outline: "none",
      fontFamily: "inherit",
      boxSizing: "border-box",
    };
    const cLabelStyle: React.CSSProperties = {
      fontSize: 10,
      color: "var(--ezy-text-muted)",
      marginBottom: 2,
      display: "block",
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
            title="Add remote server"
            style={{
              width: 18,
              height: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 3,
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

        {/* Compact add/edit form */}
        {showForm && (
          <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--ezy-border-subtle)", backgroundColor: "var(--ezy-surface)" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ezy-text)", marginBottom: 6 }}>
              {editingId ? "Edit Server" : "Add Server"}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {/* Name + Username side by side */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <div>
                  <label style={cLabelStyle}>Name</label>
                  <input style={cInputStyle} placeholder="Mac Mini" value={formData.name} onChange={(e) => updateField("name", e.target.value)} />
                </div>
                <div>
                  <label style={cLabelStyle}>Username</label>
                  <input style={cInputStyle} placeholder="nikla" value={formData.username} onChange={(e) => updateField("username", e.target.value)} />
                </div>
              </div>

              {/* Host — single field */}
              <div>
                <label style={cLabelStyle}>Host</label>
                <input
                  style={cInputStyle}
                  placeholder="192.168.1.100 or mac-mini"
                  value={formData.host}
                  onChange={(e) => updateField("host", e.target.value)}
                />
              </div>

              {/* Auth method toggle */}
              <div>
                <label style={cLabelStyle}>Auth</label>
                <div style={{ display: "flex", gap: 1, backgroundColor: "var(--ezy-bg)", borderRadius: 4, padding: 1 }}>
                  {(["ssh-key", "password"] as const).map((method) => (
                    <div
                      key={method}
                      onClick={() => {
                        updateField("authMethod", method);
                        if (method === "password") updateField("sshKeyPath", undefined as unknown as string);
                      }}
                      style={{
                        flex: 1,
                        padding: "3px 0",
                        fontSize: 10,
                        fontWeight: 600,
                        textAlign: "center",
                        borderRadius: 3,
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

              {/* Buttons */}
              <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                <div
                  onClick={handleSave}
                  style={{
                    flex: 1,
                    padding: "4px 0",
                    fontSize: 11,
                    fontWeight: 600,
                    color: isFormValid ? "#fff" : "var(--ezy-text-muted)",
                    backgroundColor: isFormValid ? "var(--ezy-accent)" : "var(--ezy-border)",
                    borderRadius: 4,
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
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 4,
                      flex: 1,
                      padding: "4px 0",
                      fontSize: 11,
                      fontWeight: 600,
                      color: isFormValid ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                      backgroundColor: "var(--ezy-border)",
                      borderRadius: 4,
                      cursor: isFormValid ? "pointer" : "default",
                      opacity: isFormValid ? 1 : 0.4,
                      transition: "background-color 120ms ease",
                    }}
                  >
                    <FaKey size={8} />
                    New Key
                  </div>
                )}
                <div
                  onClick={resetForm}
                  style={{
                    padding: "4px 12px",
                    fontSize: 11,
                    fontWeight: 500,
                    color: "var(--ezy-text-muted)",
                    cursor: "pointer",
                    borderRadius: 4,
                    transition: "background-color 120ms ease",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-border)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                >
                  Cancel
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
            const keyStatus = keySetupStatus[server.id] ?? "idle";
            const hasKey = !!server.sshKeyPath;

            return (
              <div
                key={server.id}
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
                      title="Test Connection"
                      onClick={() => handleTestConnection(server)}
                      style={{
                        width: 20, height: 20,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        borderRadius: 3, cursor: status === "testing" ? "default" : "pointer",
                        transition: "background-color 120ms ease",
                        opacity: status === "testing" ? 0.4 : 1,
                      }}
                      onMouseEnter={(e) => { if (status !== "testing") e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                    >
                      <HiMiniSignal size={11} color="var(--ezy-text-muted)" />
                    </div>
                    <div
                      title="Edit"
                      onClick={() => handleEdit(server)}
                      style={{
                        width: 20, height: 20,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        borderRadius: 3, cursor: "pointer",
                        transition: "background-color 120ms ease",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-accent-glow)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                    >
                      <FaPencil size={9} color="var(--ezy-text-muted)" />
                    </div>
                    <div
                      title={deleteConfirm === server.id ? "Click again to confirm" : "Delete"}
                      onClick={() => handleDelete(server.id)}
                      style={{
                        width: 20, height: 20,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        borderRadius: 3, cursor: "pointer",
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
                      status={keyStatus}
                      onClick={() => handleSetupKey(server.id, server.name, server.host, server.username)}
                    />
                    {keySetupError[server.id] && (
                      <div style={{ fontSize: 10, color: "var(--ezy-red)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {keySetupError[server.id]}
                      </div>
                    )}
                  </div>
                )}
                {hasKey && (
                  <div style={{ padding: "0 10px 5px 22px", fontSize: 10, color: "var(--ezy-accent)", display: "flex", alignItems: "center", gap: 4 }}>
                    <FaKey size={7} />
                    <span style={{ opacity: 0.8 }}>Key configured</span>
                    <div
                      title={copiedKey === server.sshKeyPath ? "Copied!" : "Copy public key"}
                      onClick={() => handleCopyKey(server.sshKeyPath!)}
                      style={{ cursor: "pointer", display: "flex", alignItems: "center", marginLeft: 2 }}
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
    borderRadius: 6,
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
            borderRadius: 6,
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
              borderRadius: 8,
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
                  placeholder="Mac Mini"
                  value={formData.name}
                  onChange={(e) => updateField("name", e.target.value)}
                />
              </div>
              <div>
                <label style={labelStyle}>Host</label>
                <input
                  style={inputStyle}
                  placeholder="192.168.1.100 or mac-mini"
                  value={formData.host}
                  onChange={(e) => updateField("host", e.target.value)}
                />
              </div>
              <div>
                <label style={labelStyle}>Username</label>
                <input
                  style={inputStyle}
                  placeholder="nikla"
                  value={formData.username}
                  onChange={(e) => updateField("username", e.target.value)}
                />
              </div>
            </div>

            {/* Auth method + key picker row */}
            <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "flex-end" }}>
              <div>
                <label style={labelStyle}>Auth Method</label>
                <div style={{ display: "flex", gap: 1, backgroundColor: "var(--ezy-bg)", borderRadius: 6, padding: 2 }}>
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
                        borderRadius: 4,
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

            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={!isFormValid}
                style={{
                  padding: "6px 16px",
                  backgroundColor: "var(--ezy-accent-dim)",
                  border: "none",
                  borderRadius: 6,
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
                    borderRadius: 6,
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
                  borderRadius: 6,
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
              Add a server to SSH into remote machines from EzyDev
            </p>
          </div>
        ) : servers.length > 0 && (
          <div
            style={{
              border: "1px solid var(--ezy-border)",
              borderRadius: 8,
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
              const keyStatus = keySetupStatus[server.id] ?? "idle";
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
                            title={copiedKey === server.sshKeyPath ? "Copied!" : "Copy public key"}
                            onClick={() => handleCopyKey(server.sshKeyPath!)}
                            style={{ cursor: "pointer", display: "flex", alignItems: "center" }}
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
                          status={keyStatus}
                          label="Setup Key"
                          onClick={() => handleSetupKey(server.id, server.name, server.host, server.username)}
                        />
                      )}
                      <button
                        onClick={() => handleTestConnection(server)}
                        title="Test Connection"
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
                        title="Edit"
                        className="p-1.5 rounded transition-colors"
                        style={{ backgroundColor: "transparent" }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                      >
                        <FaPencil size={13} color="var(--ezy-text-muted)" />
                      </button>
                      <button
                        onClick={() => handleDelete(server.id)}
                        title={deleteConfirm === server.id ? "Click again to confirm" : "Delete"}
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

                  {/* Key setup error */}
                  {keySetupError[server.id] && (
                    <div style={{ padding: "2px 16px 6px", fontSize: 11, color: "var(--ezy-red)" }}>
                      {keySetupError[server.id]}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

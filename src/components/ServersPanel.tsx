import { useState, useCallback } from "react";
import { useAppStore } from "../store";
import type { RemoteServer, AuthMethod } from "../types";
import { invoke } from "@tauri-apps/api/core";

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

const EMPTY_SERVER: Omit<RemoteServer, "id"> = {
  name: "",
  localIp: "",
  tailscaleHostname: "",
  username: "",
  authMethod: "ssh-key",
  sshKeyPath: "",
  defaultDirectory: "",
  preferTailscale: false,
};

export default function ServersPanel() {
  const servers = useAppStore((s) => s.servers);
  const addServer = useAppStore((s) => s.addServer);
  const updateServer = useAppStore((s) => s.updateServer);
  const removeServer = useAppStore((s) => s.removeServer);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<Omit<RemoteServer, "id">>(EMPTY_SERVER);
  const [showForm, setShowForm] = useState(false);
  const [testStatus, setTestStatus] = useState<Record<string, "idle" | "testing" | "ok" | "error">>({});
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setFormData(EMPTY_SERVER);
    setEditingId(null);
    setShowForm(false);
  }, []);

  const handleEdit = useCallback((server: RemoteServer) => {
    setFormData({
      name: server.name,
      localIp: server.localIp,
      tailscaleHostname: server.tailscaleHostname,
      username: server.username,
      authMethod: server.authMethod,
      sshKeyPath: server.sshKeyPath ?? "",
      defaultDirectory: server.defaultDirectory ?? "",
      preferTailscale: server.preferTailscale,
    });
    setEditingId(server.id);
    setShowForm(true);
  }, []);

  const handleSave = useCallback(() => {
    if (!formData.name || !formData.username || (!formData.localIp && !formData.tailscaleHostname)) return;

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
      const host = server.preferTailscale ? server.tailscaleHostname : server.localIp;
      const result = await invoke<boolean>("ssh_test_connection", {
        host,
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

  const updateField = <K extends keyof Omit<RemoteServer, "id">>(key: K, value: Omit<RemoteServer, "id">[K]) => {
    setFormData((f) => ({ ...f, [key]: value }));
  };

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
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round">
            <line x1="8" y1="3" x2="8" y2="13" />
            <line x1="3" y1="8" x2="13" y2="8" />
          </svg>
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

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
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
                <label style={labelStyle}>Username</label>
                <input
                  style={inputStyle}
                  placeholder="nikla"
                  value={formData.username}
                  onChange={(e) => updateField("username", e.target.value)}
                />
              </div>
              <div>
                <label style={labelStyle}>Local IP</label>
                <input
                  style={inputStyle}
                  placeholder="192.168.1.100"
                  value={formData.localIp}
                  onChange={(e) => updateField("localIp", e.target.value)}
                />
              </div>
              <div>
                <label style={labelStyle}>Tailscale Hostname</label>
                <input
                  style={inputStyle}
                  placeholder="mac-mini"
                  value={formData.tailscaleHostname}
                  onChange={(e) => updateField("tailscaleHostname", e.target.value)}
                />
              </div>
              <div>
                <label style={labelStyle}>Auth Method</label>
                <select
                  style={{ ...inputStyle, cursor: "pointer" }}
                  value={formData.authMethod}
                  onChange={(e) => updateField("authMethod", e.target.value as AuthMethod)}
                >
                  <option value="ssh-key">SSH Key</option>
                  <option value="password">Password</option>
                </select>
              </div>
              {formData.authMethod === "ssh-key" && (
                <div>
                  <label style={labelStyle}>SSH Key Path</label>
                  <input
                    style={inputStyle}
                    placeholder="~/.ssh/id_ed25519"
                    value={formData.sshKeyPath}
                    onChange={(e) => updateField("sshKeyPath", e.target.value)}
                  />
                </div>
              )}
              <div>
                <label style={labelStyle}>Default Directory</label>
                <input
                  style={inputStyle}
                  placeholder="/Users/nikla/projects"
                  value={formData.defaultDirectory}
                  onChange={(e) => updateField("defaultDirectory", e.target.value)}
                />
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2" style={{ fontSize: 13, color: "var(--ezy-text-secondary)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={formData.preferTailscale}
                    onChange={(e) => updateField("preferTailscale", e.target.checked)}
                    style={{ accentColor: "var(--ezy-cyan)" }}
                  />
                  Prefer Tailscale
                </label>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={!formData.name || !formData.username || (!formData.localIp && !formData.tailscaleHostname)}
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
                  opacity: (!formData.name || !formData.username || (!formData.localIp && !formData.tailscaleHostname)) ? 0.5 : 1,
                }}
              >
                {editingId ? "Update" : "Add"}
              </button>
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
                gridTemplateColumns: "1fr 140px 100px 100px 160px",
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
              const host = server.preferTailscale
                ? server.tailscaleHostname
                : server.localIp;
              const status = testStatus[server.id] ?? "idle";

              return (
                <div
                  key={server.id}
                  className="grid items-center"
                  style={{
                    gridTemplateColumns: "1fr 140px 100px 100px 160px",
                    padding: "10px 16px",
                    borderBottom: "1px solid var(--ezy-border-subtle)",
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
                  </div>
                  <span style={{ color: "var(--ezy-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                    {host}
                  </span>
                  <span style={{ color: "var(--ezy-text-muted)" }}>{server.username}</span>
                  <StatusIndicator status={status} />
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => handleTestConnection(server)}
                      title="Test Connection"
                      className="p-1.5 rounded transition-colors"
                      disabled={status === "testing"}
                      style={{ backgroundColor: "transparent" }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="var(--ezy-text-muted)"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      >
                        <path d="M2 8L6 12L14 4" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleEdit(server)}
                      title="Edit"
                      className="p-1.5 rounded transition-colors"
                      style={{ backgroundColor: "transparent" }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "var(--ezy-border)"}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="var(--ezy-text-muted)"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      >
                        <path d="M11.5 2.5L13.5 4.5L5 13H3V11L11.5 2.5Z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDelete(server.id)}
                      title={deleteConfirm === server.id ? "Click again to confirm" : "Delete"}
                      className="p-1.5 rounded transition-colors group"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke={deleteConfirm === server.id ? "var(--ezy-red)" : "var(--ezy-text-muted)"}
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        className="group-hover:stroke-[var(--ezy-red)]"
                      >
                        <line x1="4" y1="4" x2="12" y2="12" />
                        <line x1="12" y1="4" x2="4" y2="12" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

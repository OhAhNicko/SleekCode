import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GitFileStatus, GitBranchInfo, GitAheadBehind } from "../types";

type BumpLevel = "patch" | "minor" | "major";

interface ManifestInfo {
  kind: string;
  relPath: string;
  version: string;
}

interface ReleaseStep {
  step: string;
  ok: boolean;
  message: string;
}

interface RemoteInfo {
  url: string;
  owner: string;
  repo: string;
}

interface ReleaseModalProps {
  workingDir: string;
  onClose: () => void;
  onReleased: () => void;
}

function parseVersion(v: string): [number, number, number] | null {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function bumpVersion(v: string, level: BumpLevel): string {
  const parts = parseVersion(v);
  if (!parts) return v;
  let [maj, min, pat] = parts;
  if (level === "major") { maj += 1; min = 0; pat = 0; }
  else if (level === "minor") { min += 1; pat = 0; }
  else { pat += 1; }
  return `${maj}.${min}.${pat}`;
}

export default function ReleaseModal({
  workingDir,
  onClose,
  onReleased,
}: ReleaseModalProps) {
  const [manifests, setManifests] = useState<ManifestInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [level, setLevel] = useState<BumpLevel>("patch");

  const [gitFiles, setGitFiles] = useState<GitFileStatus[] | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo | null>(null);
  const [aheadBehind, setAheadBehind] = useState<GitAheadBehind | null>(null);
  const [remote, setRemote] = useState<RemoteInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [fatalError, setFatalError] = useState("");

  const [releasing, setReleasing] = useState(false);
  const [steps, setSteps] = useState<ReleaseStep[] | null>(null);

  // Release-notes publish state (Phase D: parity with /release skill).
  const [noteDraft, setNoteDraft] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{ url: string; mode: string } | null>(null);
  const [publishError, setPublishError] = useState("");
  const [ghAuthed, setGhAuthed] = useState<boolean | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);

  // Probe git + manifests in parallel.
  const probe = useCallback(async () => {
    if (!workingDir) return;
    setProbing(true);
    setFatalError("");
    try {
      const [status, br, ab, det] = await Promise.all([
        invoke<GitFileStatus[]>("git_status", { directory: workingDir }),
        invoke<GitBranchInfo>("git_branches", { directory: workingDir }),
        invoke<GitAheadBehind>("git_ahead_behind", { directory: workingDir }),
        invoke<ManifestInfo[]>("detect_manifests", { directory: workingDir }),
      ]);
      setGitFiles(status);
      setBranches(br);
      setAheadBehind(ab);
      setManifests(det);
      // Default: all detected manifests selected.
      setSelected(new Set(det.map((m) => m.relPath)));

      if (ab.hasRemote) {
        try {
          const r = await invoke<RemoteInfo>("git_remote_info", { directory: workingDir });
          setRemote(r);
        } catch {
          setRemote(null);
        }
      } else {
        setRemote(null);
      }
    } catch (err) {
      setFatalError(String(err));
    } finally {
      setProbing(false);
    }
  }, [workingDir]);

  useEffect(() => {
    probe();
  }, [probe]);

  // Escape closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !releasing) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, releasing]);

  const baseline = useMemo(() => {
    if (!manifests || manifests.length === 0) return null;
    // Use the highest detected version as baseline. Tie → first in list.
    let best = manifests[0].version;
    for (const m of manifests) {
      if (compareVersions(m.version, best) > 0) best = m.version;
    }
    return best;
  }, [manifests]);

  const versionsMismatch = useMemo(() => {
    if (!manifests || manifests.length < 2) return false;
    const first = manifests[0].version;
    return manifests.some((m) => m.version !== first);
  }, [manifests]);

  const nextVersion = baseline ? bumpVersion(baseline, level) : null;

  const treeClean = gitFiles !== null && gitFiles.length === 0;
  const onMain = branches?.current === "main" || branches?.current === "master";
  const hasRemote = !!aheadBehind?.hasRemote;
  const anySelected = selected.size > 0;
  const preflightOk =
    treeClean && onMain && hasRemote && !!nextVersion && anySelected && !!workingDir;

  const allStepsOk = steps !== null && steps.length > 0 && steps.every((s) => s.ok);
  const releasesUrl = remote?.url ? `${remote.url}/releases` : null;
  const tagsUrl = remote?.url ? `${remote.url}/tags` : null;

  const toggleManifest = (relPath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  const handleRelease = useCallback(async () => {
    if (!preflightOk || !nextVersion || !workingDir) return;
    setReleasing(true);
    setSteps([]);
    setFatalError("");
    setPublishResult(null);
    setPublishError("");
    try {
      const result = await invoke<ReleaseStep[]>("release_bump", {
        directory: workingDir,
        newVersion: nextVersion,
        manifestPaths: Array.from(selected),
      });
      setSteps(result);
      window.dispatchEvent(new Event("ezydev:git-refresh"));

      // Seed the editable notes textarea from the release_bump output.
      const notesStep = result.find((s) => s.step === "generate notes" && s.ok);
      if (notesStep && notesStep.message) {
        setNoteDraft(notesStep.message);
      }

      if (result.length > 0 && result.every((s) => s.ok)) {
        onReleased();
      }
    } catch (err) {
      setFatalError(String(err));
    } finally {
      setReleasing(false);
    }
  }, [preflightOk, nextVersion, workingDir, selected, onReleased]);

  // Probe gh auth once so the publish UI can disable itself and point the
  // user at ConnectToGitHubModal if needed.
  useEffect(() => {
    if (!workingDir) return;
    invoke<{ installed: boolean; authed: boolean }>("gh_status", { directory: workingDir })
      .then((s) => setGhAuthed(!!s.installed && !!s.authed))
      .catch(() => setGhAuthed(false));
  }, [workingDir]);

  const handlePublishNotes = useCallback(async () => {
    if (!nextVersion || !workingDir || !noteDraft.trim()) return;
    setPublishing(true);
    setPublishError("");
    try {
      const result = await invoke<{ url: string; mode: string; output: string }>(
        "gh_release_create",
        {
          directory: workingDir,
          tag: `v${nextVersion}`,
          title: `v${nextVersion}`,
          body: noteDraft,
          draft: true,
        },
      );
      setPublishResult({ url: result.url, mode: result.mode });
    } catch (err) {
      setPublishError(String(err));
    } finally {
      setPublishing(false);
    }
  }, [nextVersion, workingDir, noteDraft]);

  const openExternal = (url: string) => {
    invoke("plugin:opener|open_url", { url }).catch(() => {
      window.open(url, "_blank");
    });
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
        zIndex: 200,
      }}
      onClick={() => { if (!releasing) onClose(); }}
    >
      <div
        ref={modalRef}
        style={{
          maxWidth: 520,
          width: "100%",
          maxHeight: "80vh",
          backgroundColor: "var(--ezy-surface-raised)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 10,
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            height: 36,
            padding: "0 16px",
            borderBottom: "1px solid var(--ezy-border)",
            backgroundColor: "var(--ezy-surface)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm.5 3.25v3.5l2.25 1.35-.5.84-2.75-1.65V4.75h1Z"
                fill="var(--ezy-text)"
              />
            </svg>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ezy-text)" }}>
              Release new version
            </span>
          </div>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ezy-text-muted)"
            strokeWidth="1.5"
            strokeLinecap="round"
            style={{ cursor: releasing ? "not-allowed" : "pointer", opacity: releasing ? 0.4 : 1 }}
            onClick={() => { if (!releasing) onClose(); }}
          >
            <path d="M4 4L12 12M12 4L4 12" />
          </svg>
        </div>

        {/* Body */}
        <div style={{ padding: "16px 18px", overflowY: "auto", flex: 1 }}>
          {/* No manifests found */}
          {manifests !== null && manifests.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--ezy-text-muted)", padding: "8px 0" }}>
              No version-manifest files found in this project root
              (package.json, Cargo.toml, pyproject.toml, or tauri.conf.json).
            </div>
          )}

          {manifests !== null && manifests.length > 0 && (
            <>
              {/* Version preview */}
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: "var(--ezy-text-muted)" }}>Version</span>
                <span
                  style={{
                    fontSize: 14,
                    color: "var(--ezy-text-secondary)",
                    fontFeatureSettings: '"tnum"',
                  }}
                >
                  {baseline ?? "…"}
                </span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  style={{ color: "var(--ezy-text-muted)" }}
                  aria-hidden="true"
                >
                  <path
                    d="M3 8h10M9 4l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--ezy-text)",
                    fontFeatureSettings: '"tnum"',
                  }}
                >
                  {nextVersion ?? "…"}
                </span>
              </div>

              {versionsMismatch && (
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--ezy-text-muted)",
                    marginBottom: 14,
                    lineHeight: 1.5,
                  }}
                >
                  Manifests disagree on current version. Using the highest
                  ({baseline}) as baseline.
                </div>
              )}
              {!versionsMismatch && <div style={{ marginBottom: 14 }} />}

              {/* Manifests to bump */}
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--ezy-text-muted)",
                    marginBottom: 6,
                    fontWeight: 500,
                  }}
                >
                  Files to bump
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    border: "1px solid var(--ezy-border)",
                    borderRadius: 6,
                    padding: "6px 2px",
                  }}
                >
                  {manifests.map((m) => {
                    const isChecked = selected.has(m.relPath);
                    return (
                      <label
                        key={m.relPath}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "6px 10px",
                          cursor: releasing ? "not-allowed" : "pointer",
                          borderRadius: 4,
                          opacity: releasing ? 0.6 : 1,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={releasing}
                          onChange={() => toggleManifest(m.relPath)}
                          style={{ flexShrink: 0 }}
                        />
                        <span
                          style={{
                            fontSize: 12,
                            color: "var(--ezy-text)",
                            fontFamily: "inherit",
                          }}
                        >
                          {m.relPath}
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--ezy-text-muted)",
                            marginLeft: "auto",
                            fontFeatureSettings: '"tnum"',
                          }}
                        >
                          {m.version}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Bump level */}
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--ezy-text-muted)",
                    marginBottom: 6,
                    fontWeight: 500,
                  }}
                >
                  Bump level
                </div>
                <div
                  style={{
                    display: "flex",
                    borderRadius: 6,
                    border: "1px solid var(--ezy-border)",
                    overflow: "hidden",
                    width: "fit-content",
                  }}
                >
                  {(["patch", "minor", "major"] as const).map((opt) => {
                    const active = level === opt;
                    return (
                      <button
                        key={opt}
                        disabled={releasing}
                        onClick={() => setLevel(opt)}
                        style={{
                          padding: "6px 16px",
                          fontSize: 12,
                          fontWeight: active ? 600 : 400,
                          color: active ? "var(--ezy-text)" : "var(--ezy-text-muted)",
                          backgroundColor: active ? "var(--ezy-accent-glow)" : "transparent",
                          border: "none",
                          cursor: releasing ? "not-allowed" : "pointer",
                          fontFamily: "inherit",
                          transition: "background-color 150ms ease",
                          textTransform: "capitalize",
                        }}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Preflight gates */}
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--ezy-text-muted)",
                    marginBottom: 6,
                    fontWeight: 500,
                  }}
                >
                  Preflight
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <PreflightRow
                    ok={treeClean}
                    pending={probing && gitFiles === null}
                    label="Working tree is clean"
                    detail={
                      gitFiles && gitFiles.length > 0
                        ? `${gitFiles.length} uncommitted file${gitFiles.length === 1 ? "" : "s"}`
                        : undefined
                    }
                  />
                  <PreflightRow
                    ok={!!onMain}
                    pending={probing && branches === null}
                    label="On main branch"
                    detail={branches && !onMain ? `Currently on ${branches.current}` : undefined}
                  />
                  <PreflightRow
                    ok={hasRemote}
                    pending={probing && aheadBehind === null}
                    label="Branch has an upstream"
                    detail={aheadBehind && !hasRemote ? "No remote tracking" : undefined}
                  />
                </div>
              </div>

              {/* Buttons */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <button
                  onClick={handleRelease}
                  disabled={!preflightOk || releasing}
                  style={{
                    height: 32,
                    padding: "0 16px",
                    borderRadius: 6,
                    border:
                      preflightOk && !releasing ? "none" : "1px solid var(--ezy-border)",
                    background:
                      preflightOk && !releasing
                        ? "var(--ezy-accent)"
                        : "var(--ezy-surface)",
                    color: preflightOk && !releasing ? "#fff" : "var(--ezy-text-muted)",
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: preflightOk && !releasing ? "pointer" : "not-allowed",
                    fontFamily: "inherit",
                    flexShrink: 0,
                  }}
                >
                  {releasing
                    ? "Releasing…"
                    : nextVersion
                      ? `Release v${nextVersion}`
                      : "Release"}
                </button>
                <button
                  onClick={probe}
                  disabled={releasing}
                  style={{
                    height: 32,
                    padding: "0 12px",
                    borderRadius: 6,
                    border: "1px solid var(--ezy-border)",
                    background: "var(--ezy-surface-raised)",
                    color: "var(--ezy-text-secondary)",
                    fontSize: 12,
                    cursor: releasing ? "not-allowed" : "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Re-check
                </button>
              </div>

              {/* Step log */}
              {steps && steps.length > 0 && (
                <div
                  style={{
                    marginTop: 12,
                    border: "1px solid var(--ezy-border)",
                    borderRadius: 6,
                    overflow: "hidden",
                  }}
                >
                  {steps.filter((s) => s.step !== "generate notes").map((s, i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 10,
                        padding: "8px 12px",
                        borderBottom:
                          i === steps.length - 1
                            ? "none"
                            : "1px solid var(--ezy-border-subtle)",
                        backgroundColor: s.ok ? "transparent" : "rgba(239, 68, 68, 0.06)",
                      }}
                    >
                      <StepIcon ok={s.ok} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 500,
                            color: "var(--ezy-text)",
                          }}
                        >
                          {s.step}
                        </div>
                        {s.message && (
                          <div
                            style={{
                              fontSize: 11,
                              color: s.ok
                                ? "var(--ezy-text-muted)"
                                : "var(--ezy-red, #e55)",
                              marginTop: 2,
                              lineHeight: 1.5,
                              wordBreak: "break-word",
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            {s.message}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Success confirmation */}
              {allStepsOk && (
                <div
                  style={{
                    marginTop: 12,
                    fontSize: 12,
                    color: "var(--ezy-accent)",
                    lineHeight: 1.5,
                  }}
                >
                  Tag v{nextVersion} pushed to origin.
                  {(releasesUrl || tagsUrl) && (
                    <>
                      {" "}
                      <a
                        href={releasesUrl ?? tagsUrl ?? "#"}
                        onClick={(e) => {
                          e.preventDefault();
                          openExternal(releasesUrl ?? tagsUrl ?? "");
                        }}
                        style={{
                          color: "var(--ezy-accent)",
                          textDecoration: "underline",
                          cursor: "pointer",
                        }}
                      >
                        View on GitHub
                      </a>
                    </>
                  )}
                </div>
              )}

              {/* Release notes publish */}
              {allStepsOk && noteDraft && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--ezy-border)" }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--ezy-text)",
                      marginBottom: 6,
                    }}
                  >
                    Release notes
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--ezy-text-muted)",
                      marginBottom: 8,
                      lineHeight: 1.5,
                    }}
                  >
                    Auto-generated from git log since the previous tag. Edit before
                    publishing — these notes populate the draft release and show up in
                    the in-app changelog popup after the next auto-update.
                  </div>
                  <textarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    disabled={publishing || !!publishResult}
                    spellCheck={false}
                    rows={8}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      backgroundColor: "var(--ezy-bg)",
                      color: "var(--ezy-text)",
                      border: "1px solid var(--ezy-border)",
                      borderRadius: 6,
                      padding: "8px 10px",
                      fontSize: 12,
                      lineHeight: 1.5,
                      fontFamily: "inherit",
                      resize: "vertical",
                      minHeight: 120,
                      outline: "none",
                      whiteSpace: "pre-wrap",
                      opacity: publishResult ? 0.7 : 1,
                    }}
                  />
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                    {!publishResult && (
                      <button
                        onClick={handlePublishNotes}
                        disabled={publishing || !noteDraft.trim() || ghAuthed === false}
                        style={{
                          height: 30,
                          padding: "0 14px",
                          borderRadius: 6,
                          border: "none",
                          background: "var(--ezy-accent)",
                          color: "#0d1117",
                          fontSize: 12,
                          fontWeight: 600,
                          cursor:
                            publishing || !noteDraft.trim() || ghAuthed === false
                              ? "not-allowed"
                              : "pointer",
                          opacity:
                            publishing || !noteDraft.trim() || ghAuthed === false ? 0.6 : 1,
                          fontFamily: "inherit",
                          flexShrink: 0,
                        }}
                      >
                        {publishing ? "Publishing..." : "Publish draft release"}
                      </button>
                    )}
                    {publishResult && (
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--ezy-accent)",
                          lineHeight: 1.5,
                        }}
                      >
                        Draft release {publishResult.mode === "edited" ? "updated" : "created"}.
                        {publishResult.url && (
                          <>
                            {" "}
                            <a
                              href={publishResult.url}
                              onClick={(e) => {
                                e.preventDefault();
                                openExternal(publishResult.url);
                              }}
                              style={{
                                color: "var(--ezy-accent)",
                                textDecoration: "underline",
                                cursor: "pointer",
                              }}
                            >
                              Edit on GitHub
                            </a>
                          </>
                        )}
                      </div>
                    )}
                    {ghAuthed === false && !publishResult && (
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--ezy-text-muted)",
                          lineHeight: 1.4,
                        }}
                      >
                        Install `gh` and run `gh auth login` to auto-publish.
                      </span>
                    )}
                  </div>
                  {publishError && (
                    <div
                      style={{
                        marginTop: 8,
                        fontSize: 11,
                        color: "var(--ezy-red)",
                        lineHeight: 1.5,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {publishError}
                    </div>
                  )}
                </div>
              )}

              {fatalError && (
                <div
                  style={{
                    marginTop: 12,
                    fontSize: 12,
                    color: "var(--ezy-red, #e55)",
                    lineHeight: 1.5,
                  }}
                >
                  {fatalError}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PreflightRow({
  ok,
  pending,
  label,
  detail,
}: {
  ok: boolean;
  pending: boolean;
  label: string;
  detail?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
      {pending ? (
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            border: "2px solid var(--ezy-border)",
            borderTopColor: "var(--ezy-text-muted)",
            animation: "ezy-spin 0.9s linear infinite",
            flexShrink: 0,
          }}
        />
      ) : ok ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }} aria-hidden="true">
          <path
            d="M3 8.5L6.5 12L13 4"
            stroke="var(--ezy-accent)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }} aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="var(--ezy-red, #e55)" strokeWidth="1.5" />
          <path
            d="M5.5 5.5L10.5 10.5M10.5 5.5L5.5 10.5"
            stroke="var(--ezy-red, #e55)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )}
      <span
        style={{
          fontSize: 12,
          color: pending
            ? "var(--ezy-text-muted)"
            : ok
              ? "var(--ezy-text-secondary)"
              : "var(--ezy-text)",
        }}
      >
        {label}
      </span>
      {detail && (
        <span style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>
          — {detail}
        </span>
      )}
    </div>
  );
}

function StepIcon({ ok }: { ok: boolean }) {
  if (ok) {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        style={{ flexShrink: 0, marginTop: 1 }}
      >
        <path
          d="M3 8.5L6.5 12L13 4"
          stroke="var(--ezy-accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      style={{ flexShrink: 0, marginTop: 1 }}
    >
      <circle cx="8" cy="8" r="6.5" stroke="var(--ezy-red, #e55)" strokeWidth="1.5" />
      <path
        d="M5.5 5.5L10.5 10.5M10.5 5.5L5.5 10.5"
        stroke="var(--ezy-red, #e55)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

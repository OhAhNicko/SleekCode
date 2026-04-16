import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "../store";
import type { GitFileStatus, GitBranchInfo, GitAheadBehind } from "../types";

type BumpLevel = "patch" | "minor" | "major";

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

function parseVersion(v: string): [number, number, number] | null {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
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

interface ReleaseSectionProps {}

export default function ReleaseSection(_props: ReleaseSectionProps) {
  const tabs = useAppStore((s) => s.tabs);
  // Find the first non-settings tab — release operates on a project directory.
  const projectDir = useMemo(() => {
    const t = tabs.find((t) => !t.isSettingsTab && t.workingDir);
    return t?.workingDir ?? "";
  }, [tabs]);

  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [level, setLevel] = useState<BumpLevel>("patch");

  const [gitFiles, setGitFiles] = useState<GitFileStatus[] | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo | null>(null);
  const [aheadBehind, setAheadBehind] = useState<GitAheadBehind | null>(null);
  const [remote, setRemote] = useState<RemoteInfo | null>(null);
  const [probing, setProbing] = useState(false);

  const [releasing, setReleasing] = useState(false);
  const [steps, setSteps] = useState<ReleaseStep[] | null>(null);
  const [fatalError, setFatalError] = useState("");

  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(() => {});
  }, []);

  const probeGit = useCallback(async () => {
    if (!projectDir) return;
    setProbing(true);
    try {
      const [status, br, ab] = await Promise.all([
        invoke<GitFileStatus[]>("git_status", { directory: projectDir }),
        invoke<GitBranchInfo>("git_branches", { directory: projectDir }),
        invoke<GitAheadBehind>("git_ahead_behind", { directory: projectDir }),
      ]);
      setGitFiles(status);
      setBranches(br);
      setAheadBehind(ab);

      if (ab.hasRemote) {
        try {
          const r = await invoke<RemoteInfo>("git_remote_info", { directory: projectDir });
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
  }, [projectDir]);

  useEffect(() => {
    probeGit();
  }, [probeGit]);

  const nextVersion = currentVersion ? bumpVersion(currentVersion, level) : null;

  const treeClean = gitFiles !== null && gitFiles.length === 0;
  const onMain = branches?.current === "main" || branches?.current === "master";
  const hasRemote = !!aheadBehind?.hasRemote;
  const preflightOk = treeClean && onMain && hasRemote && !!nextVersion && !!projectDir;

  const handleRelease = useCallback(async () => {
    if (!preflightOk || !nextVersion || !projectDir) return;
    setReleasing(true);
    setSteps([]);
    setFatalError("");
    try {
      const result = await invoke<ReleaseStep[]>("release_bump", {
        directory: projectDir,
        newVersion: nextVersion,
      });
      setSteps(result);
      // Refresh git state
      probeGit();
      // Fire a global refresh so CodeReviewPane / GitStatusBar update too.
      window.dispatchEvent(new Event("ezydev:git-refresh"));
    } catch (err) {
      setFatalError(String(err));
    } finally {
      setReleasing(false);
    }
  }, [preflightOk, nextVersion, projectDir, probeGit]);

  const allStepsOk = steps !== null && steps.length > 0 && steps.every((s) => s.ok);
  const releasesUrl = remote?.url ? `${remote.url}/releases` : null;

  return (
    <section id="release" style={{ paddingTop: 8, paddingBottom: 32 }}>
      <h2
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: "var(--ezy-text)",
          margin: "0 0 4px",
          letterSpacing: "-0.01em",
        }}
      >
        Release a new version
      </h2>
      <p style={{ fontSize: 12, color: "var(--ezy-text-muted)", margin: "0 0 14px", lineHeight: 1.5 }}>
        Bumps the version across package.json, Cargo.toml, and tauri.conf.json, then commits, tags, and pushes to trigger the release workflow.
      </p>

      {!projectDir && (
        <div style={{ fontSize: 12, color: "var(--ezy-text-muted)", padding: "8px 0" }}>
          Open a project tab to release.
        </div>
      )}

      {projectDir && (
        <>
          {/* Version preview */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 16 }}>
            <span style={{ fontSize: 12, color: "var(--ezy-text-muted)" }}>Version</span>
            <span style={{ fontSize: 14, color: "var(--ezy-text-secondary)", fontFeatureSettings: '"tnum"' }}>
              {currentVersion ?? "…"}
            </span>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ color: "var(--ezy-text-muted)" }} aria-hidden="true">
              <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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

          {/* Bump level */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 6, fontWeight: 500 }}>
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
            <div style={{ fontSize: 11, color: "var(--ezy-text-muted)", marginBottom: 6, fontWeight: 500 }}>
              Preflight
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <PreflightRow
                ok={treeClean}
                pending={probing && gitFiles === null}
                label="Working tree is clean"
                detail={gitFiles && gitFiles.length > 0 ? `${gitFiles.length} uncommitted file${gitFiles.length === 1 ? "" : "s"}` : undefined}
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

          {/* Release button */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <button
              onClick={handleRelease}
              disabled={!preflightOk || releasing}
              style={{
                height: 32,
                padding: "0 16px",
                borderRadius: 6,
                border: preflightOk && !releasing ? "none" : "1px solid var(--ezy-border)",
                background: preflightOk && !releasing ? "var(--ezy-accent)" : "var(--ezy-surface)",
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
              onClick={probeGit}
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

          {/* Progress log */}
          {steps && steps.length > 0 && (
            <div
              style={{
                marginTop: 4,
                border: "1px solid var(--ezy-border)",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              {steps.map((s, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: "8px 12px",
                    borderBottom: i === steps.length - 1 ? "none" : "1px solid var(--ezy-border-subtle)",
                    backgroundColor: s.ok ? "transparent" : "rgba(239, 68, 68, 0.06)",
                  }}
                >
                  <StepIcon ok={s.ok} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: "var(--ezy-text)" }}>
                      {s.step}
                    </div>
                    {s.message && (
                      <div
                        style={{
                          fontSize: 11,
                          color: s.ok ? "var(--ezy-text-muted)" : "var(--ezy-red, #e55)",
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

          {allStepsOk && (
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--ezy-accent)", lineHeight: 1.5 }}>
              Tag pushed. GitHub Actions is building the release.
              {releasesUrl && (
                <>
                  {" "}
                  <a
                    href={releasesUrl}
                    onClick={(e) => {
                      e.preventDefault();
                      invoke("plugin:opener|open_url", { url: releasesUrl }).catch(() => {
                        window.open(releasesUrl, "_blank");
                      });
                    }}
                    style={{ color: "var(--ezy-accent)", textDecoration: "underline", cursor: "pointer" }}
                  >
                    View releases
                  </a>
                </>
              )}
            </div>
          )}

          {fatalError && (
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--ezy-red, #e55)", lineHeight: 1.5 }}>
              {fatalError}
            </div>
          )}
        </>
      )}
    </section>
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
          <path d="M3 8.5L6.5 12L13 4" stroke="var(--ezy-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }} aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="var(--ezy-red, #e55)" strokeWidth="1.5" />
          <path d="M5.5 5.5L10.5 10.5M10.5 5.5L5.5 10.5" stroke="var(--ezy-red, #e55)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
      <span
        style={{
          fontSize: 12,
          color: pending ? "var(--ezy-text-muted)" : ok ? "var(--ezy-text-secondary)" : "var(--ezy-text)",
        }}
      >
        {label}
      </span>
      {detail && (
        <span style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>
          — {detail}
        </span>
      )}
      <style>{`
        @keyframes ezy-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

function StepIcon({ ok }: { ok: boolean }) {
  if (ok) {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
        <path d="M3 8.5L6.5 12L13 4" stroke="var(--ezy-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
      <circle cx="8" cy="8" r="6.5" stroke="var(--ezy-red, #e55)" strokeWidth="1.5" />
      <path d="M5.5 5.5L10.5 10.5M10.5 5.5L5.5 10.5" stroke="var(--ezy-red, #e55)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

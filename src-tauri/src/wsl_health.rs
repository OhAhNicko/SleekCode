//! WSL host-config health: make the WSL2 VM return freed memory.
//!
//! Every WSL pane's processes (Claude Code's node runtime above all) live in
//! the single WSL2 utility VM. Without `autoMemoryReclaim` the VM hoards every
//! page it ever touched — with the default cap of 50% of host RAM, a dozen AI
//! sessions plus builds fill it, Linux starts OOM-thrashing, and the VM wedges
//! until the user runs `wsl --shutdown` (the "WSL died" report this fixes).
//!
//! `wsl_ensure_memory_reclaim` adds the two Microsoft-documented settings to
//! the user's `%USERPROFILE%\.wslconfig`:
//!
//! ```ini
//! [experimental]
//! autoMemoryReclaim=gradual
//! sparseVhd=true
//! ```
//!
//! The `[experimental]` section is load-bearing: WSL silently ignores these
//! keys under `[wsl2]`.
//!
//! # Respect for the user's file
//!
//! - **Additive only.** If `autoMemoryReclaim` appears anywhere in the file —
//!   any value, even commented out — the file is the user's opinion and is
//!   left untouched ("already"). `sparseVhd` is only added when absent.
//! - **Backed up.** A pre-edit copy is written to `.wslconfig.made-bak` once
//!   (never overwritten on later runs).
//! - **Applied at most once per install.** The frontend gates the call on a
//!   localStorage marker, so a user who deletes the keys afterwards is not
//!   fought with re-adds.
//! - **Never restarts WSL.** The settings apply on the next `wsl --shutdown`;
//!   killing the VM would destroy the user's live sessions, so that step is
//!   always the user's.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant, UNIX_EPOCH};

const RECLAIM_KEY: &str = "autoMemoryReclaim";
const SPARSE_KEY: &str = "sparseVhd";

fn wslconfig_path() -> Result<PathBuf, String> {
    let profile = std::env::var("USERPROFILE")
        .map_err(|_| "USERPROFILE is not set".to_string())?;
    Ok(PathBuf::from(profile).join(".wslconfig"))
}

/// Build the new file contents, or None when nothing should change.
fn amended(existing: &str) -> Option<String> {
    if existing.contains(RECLAIM_KEY) {
        return None;
    }
    let add_sparse = !existing.contains(SPARSE_KEY);
    let mut lines: Vec<String> = existing.lines().map(str::to_string).collect();
    let header_idx = lines
        .iter()
        .position(|l| l.trim().eq_ignore_ascii_case("[experimental]"));
    match header_idx {
        Some(i) => {
            // Insert directly under the existing header so the keys land in
            // the right section no matter what follows it.
            lines.insert(i + 1, format!("{RECLAIM_KEY}=gradual"));
            if add_sparse {
                lines.insert(i + 2, format!("{SPARSE_KEY}=true"));
            }
        }
        None => {
            if !lines.is_empty() {
                lines.push(String::new());
            }
            lines.push("[experimental]".to_string());
            lines.push(format!("{RECLAIM_KEY}=gradual"));
            if add_sparse {
                lines.push(format!("{SPARSE_KEY}=true"));
            }
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    Some(out)
}

/// Returns "already" | "applied" | "created" | "unsupported".
#[tauri::command]
pub async fn wsl_ensure_memory_reclaim() -> Result<String, String> {
    if !cfg!(windows) {
        return Ok("unsupported".into());
    }
    let path = wslconfig_path()?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let Some(next) = amended(&existing) else {
        return Ok("already".into());
    };
    if !existing.is_empty() {
        let bak = path.with_extension("made-bak");
        if !bak.exists() {
            std::fs::write(&bak, &existing)
                .map_err(|e| format!("backup failed, aborting: {e}"))?;
        }
    }
    std::fs::write(&path, next).map_err(|e| e.to_string())?;
    Ok(if existing.is_empty() { "created" } else { "applied" }.into())
}

// ---------------------------------------------------------------------------
// Pane "workingness" ground truth (tab hibernation idle gate)
// ---------------------------------------------------------------------------

/// One tagged pane's aggregate CPU inside the WSL VM.
///
/// Every pane's Linux process tree carries `MADE_PANE_ID=<terminalId>` in its
/// environment (injected at spawn — see `terminal-config.ts`), and children
/// (claude → subagents → build tools) inherit it. Summed utime+stime ticks
/// across the tree, sampled twice, is the honest "is any work happening"
/// signal that output heuristics can't fake: silent subagents and quiet
/// builds burn CPU whether or not they print.
#[derive(serde::Serialize)]
pub struct PaneCpuSample {
    pub pane_id: String,
    pub cpu_ticks: u64,
    pub proc_count: u32,
}

/// Single-line on purpose: multi-line scripts must go over stdin (below)
/// because `wsl.exe -- bash -c <arg>` re-splits argv (the documented
/// `--resume` mangling class). `/proc/<pid>/stat` is parsed by stripping up
/// to the last `)` — the comm field may contain spaces/parens — leaving
/// utime/stime at positional fields 12/13 of the remainder.
const SWEEP_SCRIPT: &str = r#"for p in /proc/[0-9]*; do [ -r "$p/environ" ] || continue; id=$(tr "\0" "\n" < "$p/environ" 2>/dev/null | grep -m1 "^MADE_PANE_ID=" | cut -d= -f2); [ -n "$id" ] || continue; st=$(cat "$p/stat" 2>/dev/null) || continue; rest=${st##*) }; set -- $rest; echo "$id $((${12}+${13}))"; done"#;

/// Run a command with the script piped over stdin and a hard deadline.
///
/// The deadline matters more than usual here: this runs periodically, and the
/// exact failure being defended against is "the WSL VM is wedged" — a plain
/// `.output()` would then block a tokio worker forever. Output is a handful
/// of tiny lines, far below the pipe buffer, so polling `try_wait` without
/// draining stdout cannot deadlock.
fn run_script_with_deadline(
    mut cmd: std::process::Command,
    script: &str,
    deadline: Duration,
) -> Result<std::process::Output, String> {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(script.as_bytes())
            .map_err(|e| format!("stdin write failed: {e}"))?;
        // Dropped here — closes the pipe so bash sees EOF and runs the script.
    }
    wait_with_deadline(child, deadline)
}

/// Poll `try_wait` until exit or deadline (then kill). Never blocks past the
/// deadline — every caller here exists to deal with a possibly-wedged VM.
fn wait_with_deadline(
    mut child: std::process::Child,
    deadline: Duration,
) -> Result<std::process::Output, String> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().map_err(|e| e.to_string()),
            Ok(None) => {
                if start.elapsed() > deadline {
                    let _ = child.kill();
                    return Err("timed out (WSL unresponsive?)".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// User-invoked WSL reset (Settings > General > Danger Zone). `wsl --shutdown`
/// kills every WSL process — all of MADE's WSL panes included — and stops the
/// VM; the next wsl.exe invocation boots it fresh, picking up any .wslconfig
/// changes. Destructive by design, so it is only ever reachable behind the
/// frontend's explicit confirmation dialog; MADE never calls this on its own.
#[tauri::command]
pub async fn wsl_shutdown() -> Result<(), String> {
    if !cfg!(windows) {
        return Err("unsupported platform".into());
    }
    let mut cmd = crate::wsl_command();
    cmd.arg("--shutdown")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let out = wait_with_deadline(child, Duration::from_secs(30))?;
    if !out.status.success() {
        return Err(format!(
            "wsl --shutdown exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    // The pre-warmed pool is now a box of corpses — flush it BEFORE the
    // frontend starts respawning panes, or pooled spawns die instantly.
    crate::pty::flush_wsl_pool();
    Ok(())
}

/// Sweep the WSL VM once and return per-pane CPU tick totals. The frontend
/// samples twice and treats the DELTA as the busy signal. A pane missing from
/// the result has no live tagged processes (or they are unreadable) — the
/// caller must treat that as "signal unavailable → not idle", never as idle.
#[tauri::command]
pub async fn wsl_pane_activity(distro: Option<String>) -> Result<Vec<PaneCpuSample>, String> {
    if !cfg!(windows) {
        return Ok(Vec::new());
    }
    let mut cmd = crate::wsl_command();
    if let Some(ref d) = distro {
        if !d.trim().is_empty() {
            cmd.arg("-d").arg(d);
        }
    }
    cmd.args(["--", "bash"]);
    let out = run_script_with_deadline(cmd, SWEEP_SCRIPT, Duration::from_secs(10))?;
    if !out.status.success() {
        return Err(format!("sweep exited with {}", out.status));
    }
    let mut agg: HashMap<String, (u64, u32)> = HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = line.split_whitespace();
        let (Some(id), Some(ticks)) = (it.next(), it.next()) else {
            continue;
        };
        let ticks: u64 = ticks.parse().unwrap_or(0);
        let e = agg.entry(id.to_string()).or_insert((0, 0));
        e.0 += ticks;
        e.1 += 1;
    }
    Ok(agg
        .into_iter()
        .map(|(pane_id, (cpu_ticks, proc_count))| PaneCpuSample {
            pane_id,
            cpu_ticks,
            proc_count,
        })
        .collect())
}

/// Last-write time (epoch ms) of a Claude session's transcript activity:
/// max(session .jsonl mtime, its project-dir mtime). The dir mtime catches
/// subagent sidecar files being CREATED; ongoing appends bump the file mtime.
/// Stat'd over the `\\wsl.localhost` UNC share — no wsl.exe round-trip
/// (same rationale as `read_sessions_index`). Errors mean "can't prove
/// anything" and the caller must fail safe (not idle).
#[tauri::command]
pub async fn claude_session_activity_mtime(
    project_path: String,
    session_id: String,
    distro: Option<String>,
) -> Result<u64, String> {
    if !cfg!(windows) {
        return Err("unsupported platform".into());
    }
    let file = crate::resolve_wsl_session_jsonl(&project_path, &session_id, distro.as_deref())
        .ok_or_else(|| "session file not found".to_string())?;
    let ms = |p: &std::path::Path| -> Option<u64> {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis() as u64)
    };
    let file_ms = ms(&file).ok_or_else(|| "session file unreadable".to_string())?;
    let dir_ms = file.parent().and_then(ms).unwrap_or(0);
    Ok(file_ms.max(dir_ms))
}

#[cfg(test)]
mod tests {
    use super::amended;

    #[test]
    fn untouched_when_key_present() {
        assert!(amended("[experimental]\nautoMemoryReclaim=dropcache\n").is_none());
        // A commented-out key is still the user's decision.
        assert!(amended("#autoMemoryReclaim=gradual\n").is_none());
    }

    #[test]
    fn appends_section_when_missing() {
        let out = amended("[wsl2]\nnetworkingMode=mirrored\n").unwrap();
        assert!(out.contains("[experimental]\nautoMemoryReclaim=gradual\nsparseVhd=true"));
        assert!(out.starts_with("[wsl2]\nnetworkingMode=mirrored\n"));
    }

    #[test]
    fn inserts_under_existing_header_without_duplicating_sparse() {
        let out = amended("[experimental]\nsparseVhd=false\n").unwrap();
        assert_eq!(out, "[experimental]\nautoMemoryReclaim=gradual\nsparseVhd=false\n");
    }

    #[test]
    fn creates_from_empty() {
        let out = amended("").unwrap();
        assert_eq!(out, "[experimental]\nautoMemoryReclaim=gradual\nsparseVhd=true\n");
    }
}

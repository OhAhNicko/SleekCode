//! Finding the MADE instance to talk to.
//!
//! Each running MADE writes `endpoint-<pid>.json` (plus a legacy singular
//! `endpoint.json`) into its `app_local_data_dir/knowledge/` directory. There
//! can legitimately be several: running a dev build beside the installed one is
//! a daily occurrence here, and both write their own file.
//!
//! So discovery is a PROBE, not a read. The caller tries every candidate, and
//! binds to the instance whose `hello-ok` reports writable (`rw`) ownership of
//! this adapter's project — falling back to a read-only follower only when no
//! writable instance answers. Picking "the newest file" instead would make the
//! choice depend on start order, which is exactly the coin-flip the dev-beside-
//! production case must not have.
//!
//! Nothing here is durable state: the adapter re-reads these files on every
//! reconnect attempt, so restarting MADE recovers without restarting the CLI.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Must match `tauri.conf.json`'s `identifier`. `app_local_data_dir` is
/// `data_local_dir()/identifier`, and this binary has no Tauri to ask.
pub const APP_IDENTIFIER: &str = "com.made.app";

/// An explicit endpoint file, overriding discovery entirely. The smoke test
/// points this at a mock service; there is no production path that sets it.
pub const ENDPOINT_ENV: &str = "MADE_KNOWLEDGE_ENDPOINT";

/// camelCase because `ipc::write_endpoint_files` writes `appVersion` and
/// `startedAt`. Getting this wrong is silent: every `startedAt` reads as 0 and
/// the newest-first ordering quietly becomes no ordering at all.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
    #[serde(default)]
    pub pid: u32,
    #[serde(default)]
    pub started_at: i64,
    #[serde(default)]
    pub app_version: String,
}

/// `%LOCALAPPDATA%` / `~/Library/Application Support` / `$XDG_DATA_HOME`, the
/// same three roots `dirs::data_local_dir()` resolves — hand-rolled so the
/// adapter carries no dependency for one path.
fn data_local_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .filter(|v| !v.is_empty())
            .map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .filter(|v| !v.is_empty())
                    .map(|h| PathBuf::from(h).join(".local").join("share"))
            })
    }
}

/// Where MADE keeps its knowledge databases and endpoint files. The leaf is
/// per-build (live/dev isolation): a debug adapter probes only the dev
/// world's endpoints and can never bind to a production MADE.
pub fn knowledge_dir() -> Option<PathBuf> {
    let leaf = if cfg!(debug_assertions) { "knowledge-dev" } else { "knowledge" };
    Some(data_local_dir()?.join(APP_IDENTIFIER).join(leaf))
}

/// Every candidate MADE instance, newest first.
///
/// Newest-first is a tie-break, not the decision: the caller still probes each
/// one and prefers whichever reports write ownership. It only decides the order
/// two equally-valid instances are tried in, where trying the more recently
/// started one first is the better guess.
pub fn discover(explicit: Option<&Path>) -> Vec<Endpoint> {
    if let Some(path) = explicit {
        return read_one(path).into_iter().collect();
    }
    if let Some(path) = std::env::var_os(ENDPOINT_ENV).filter(|v| !v.is_empty()) {
        return read_one(Path::new(&path)).into_iter().collect();
    }

    let Some(dir) = knowledge_dir() else {
        return Vec::new();
    };
    let mut found: Vec<Endpoint> = Vec::new();
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("endpoint-") && name.ends_with(".json") {
                paths.push(entry.path());
            }
        }
    }
    // The legacy singular file last: an instance that wrote both is already
    // represented, and dedupe below drops the duplicate.
    paths.push(dir.join("endpoint.json"));

    for path in paths {
        let Some(ep) = read_one(&path) else { continue };
        if found
            .iter()
            .any(|e| e.port == ep.port && e.token == ep.token)
        {
            continue;
        }
        found.push(ep);
    }
    found.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    found
}

fn read_one(path: &Path) -> Option<Endpoint> {
    let raw = std::fs::read_to_string(path).ok()?;
    let ep: Endpoint = serde_json::from_str(&raw).ok()?;
    // A file with no port or no token is a half-written or foreign file, not an
    // instance — connecting to port 0 would just waste the probe budget.
    (ep.port != 0 && !ep.token.is_empty()).then_some(ep)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "made-mcp-endpoint-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&p).expect("create temp dir");
            Self(p)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, body).expect("write endpoint file");
        p
    }

    #[test]
    fn an_explicit_file_wins_and_parses() {
        let dir = TempDir::new();
        let path = write(
            &dir.0,
            "endpoint.json",
            r#"{"v":1,"port":50505,"token":"abc","pid":9,"appVersion":"0.2.16","startedAt":5}"#,
        );
        let found = discover(Some(&path));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].port, 50505);
        assert_eq!(found[0].token, "abc");
        // Both camelCase keys, because both are silent when they fail: a lost
        // `startedAt` turns newest-first into arbitrary order, and a lost
        // `appVersion` empties the one log line that says which MADE answered.
        assert_eq!(found[0].app_version, "0.2.16");
        assert_eq!(found[0].started_at, 5);
        assert_eq!(found[0].pid, 9);
    }

    #[test]
    fn unusable_files_are_skipped_rather_than_probed() {
        let dir = TempDir::new();
        // Half-written, foreign, and syntactically broken files all live in the
        // same directory as real ones; each must cost nothing.
        let no_port = write(&dir.0, "a.json", r#"{"port":0,"token":"x"}"#);
        let no_token = write(&dir.0, "b.json", r#"{"port":1,"token":""}"#);
        let garbage = write(&dir.0, "c.json", "not json at all");
        for p in [no_port, no_token, garbage] {
            assert!(discover(Some(&p)).is_empty(), "{} was accepted", p.display());
        }
        assert!(discover(Some(&dir.0.join("missing.json"))).is_empty());
    }

    #[test]
    fn read_one_prefers_nothing_over_a_guess() {
        // Deliberately not defaulting a missing port to something plausible:
        // the failure of a probe is recoverable, a connection to the wrong
        // local port is not.
        let dir = TempDir::new();
        let p = write(&dir.0, "d.json", r#"{"token":"x"}"#);
        assert!(read_one(&p).is_none());
    }

    #[test]
    fn the_knowledge_dir_sits_under_the_app_identifier() {
        // A drift between this and tauri.conf.json's identifier would make the
        // adapter look in a directory MADE never writes — the exact failure the
        // remote-session readers hit once already. The leaf is per-build:
        // debug adapters live in the dev world, never the live one.
        let leaf = if cfg!(debug_assertions) { "knowledge-dev" } else { "knowledge" };
        if let Some(dir) = knowledge_dir() {
            let text = dir.to_string_lossy().replace('\\', "/");
            assert!(text.ends_with(&format!("{APP_IDENTIFIER}/{leaf}")), "{text}");
        }
    }
}

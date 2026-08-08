//! Registering `made-knowledge` with Claude Code, Codex and Gemini.
//!
//! The adapter binary is useless until a CLI knows to launch it, and each CLI
//! keeps that registration somewhere different: `~/.claude.json`,
//! `~/.codex/config.toml`, `~/.gemini/settings.json`. This module detects and
//! writes those registrations — but never by editing the files.
//!
//! **MADE always shells out to the CLI's own `mcp add` / `mcp remove`.** The
//! config shape belongs to each CLI, each ships the version-correct writer for
//! it, and a hand-written entry that a CLI later stops understanding is a
//! failure nobody can diagnose from inside MADE.
//!
//! Two rules the UI depends on:
//!
//! - **Unknown is not missing.** A config we could not read produces
//!   `checked: false`, which renders as "Unknown" — telling someone to install
//!   what they already have is worse than saying nothing.
//! - **Configured is not necessarily configured to US.** A registration left by
//!   a moved or reinstalled MADE points at an adapter that is not there. That
//!   reads as Connected while every tool call goes nowhere, so the registered
//!   path is compared against this build's and reported separately.
//!
//! One registration per environment serves every project: the adapter works out
//! which project it is in from its own working directory, so the scope is always
//! `user` where a scope exists at all.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

use crate::{
    claude_json_at, find_mcp_in_claude_json, find_mcp_in_codex_toml, find_mcp_in_gemini_settings,
    find_mcp_in_project_file, resolve_wsl_home_for, wait_for_mcp_add, JiraCli, McpEntry,
};

/// The name MADE registers under, in every CLI — per build. A debug build
/// registers, detects, repairs and removes ONLY its own `-dev` entry; the
/// live registration is invisible to it, never rendered as "Registered
/// elsewhere" and never touched by its Fix (live/dev isolation, 2026-08-07).
/// Served to the frontend via `knowledge_world`; the TS constant is a
/// release-default the boot fetch overwrites.
#[cfg(debug_assertions)]
pub const SERVER_NAME: &str = "made-nexus-dev";
#[cfg(not(debug_assertions))]
pub const SERVER_NAME: &str = "made-nexus";

/// Pre-rename spellings (2026-08-08, made-knowledge → made-nexus). An entry
/// under OUR world's legacy name is ours-needing-re-registration (the row
/// offers the Update repair); the OTHER world's legacy name is exactly as
/// untouchable as its current one.
#[cfg(debug_assertions)]
const LEGACY_SERVER_NAME: &str = "made-knowledge-dev";
#[cfg(not(debug_assertions))]
const LEGACY_SERVER_NAME: &str = "made-knowledge";
#[cfg(debug_assertions)]
const OTHER_WORLD_LEGACY_NAME: &str = "made-knowledge";
#[cfg(not(debug_assertions))]
const OTHER_WORLD_LEGACY_NAME: &str = "made-knowledge-dev";

/// The adapter executable, next to `made.exe`.
const ADAPTER_STEM: &str = "made-knowledge-mcp";

/// Every `mcp add` and `mcp remove` gets this bound.
///
/// Unlike the Atlassian path, **exit 124 is an ERROR for all three CLIs here**.
/// Codex's Atlassian add deliberately hangs on an OAuth callback after writing
/// its entry, so a timeout there means success; a stdio server has no OAuth at
/// all, so a timeout here means something is genuinely stuck and reporting it as
/// "added" would leave the user with a registration that does not exist.
const DEADLINE_SECS: u64 = 45;

/// What one CLI's config says about `made-knowledge`.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeMcpStatus {
    pub configured: bool,
    /// Where it was found: "user", "local" (this project, in ~/.claude.json) or
    /// "project" (a committed .mcp.json).
    pub scope: String,
    pub name: String,
    /// False when the config could not be read at all. The UI must render this
    /// as "Unknown", never as "Not set up".
    pub checked: bool,
    /// The adapter path this CLI has on file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registered_path: Option<String>,
    /// `Some(false)` ONLY when a different adapter was positively identified.
    /// `None` means not reported, which must not render as a mismatch — same
    /// reasoning as `checked`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_matches: Option<bool>,
}

impl KnowledgeMcpStatus {
    /// The config could not be read. Everything else about it is unknown too.
    fn unknown() -> Self {
        Self {
            name: SERVER_NAME.to_string(),
            ..Default::default()
        }
    }

    /// The config was read and holds no such server.
    fn absent() -> Self {
        Self {
            checked: true,
            name: SERVER_NAME.to_string(),
            ..Default::default()
        }
    }

    fn found(entry: McpEntry, scope: &str, expected: Option<&Path>) -> Self {
        let path_matches = match (&entry.command, expected) {
            (Some(registered), Some(expected)) => {
                Some(same_adapter(registered, &expected.to_string_lossy()))
            }
            // Nothing to compare: either the CLI recorded no command (a URL
            // server wearing our name) or this MADE cannot find its own
            // adapter. Reporting a mismatch on a missing fact would send the
            // user to re-register something that may be perfectly correct.
            _ => None,
        };
        Self {
            configured: true,
            scope: scope.to_string(),
            name: entry.name,
            checked: true,
            registered_path: entry.command,
            path_matches,
        }
    }
}

/// Does this entry point at MADE's knowledge adapter?
///
/// Exact name, or a LAUNCH COMMAND that is our adapter — so a server the user
/// renamed is still recognised, and MADE never offers to install a second copy
/// of something already there under another name.
///
/// Only the `command` counts, never the whole serialized entry. Matching any
/// mention of the stem claimed servers that merely REFERENCE the adapter — a
/// wrapper script, a bridge, a `--watch` argument naming the path — and the
/// consequences were not cosmetic: the row reported someone else's server as
/// MADE's, offered to remove it, and (because the scan returns the first hit)
/// never offered Install again, so the state was unreachable by any button.
/// The OTHER build's canonical name. Never ours — not even when its command
/// points at an adapter with our stem: a debug build claiming the live
/// registration would render it "Registered elsewhere" and its Fix would
/// REMOVE the live entry, putting production panes on the debug adapter. Each
/// world touches only its own name (live/dev isolation, 2026-08-07).
#[cfg(debug_assertions)]
const OTHER_WORLD_SERVER_NAME: &str = "made-nexus";
#[cfg(not(debug_assertions))]
const OTHER_WORLD_SERVER_NAME: &str = "made-nexus-dev";

pub fn is_knowledge_entry(name: &str, value: &serde_json::Value) -> bool {
    if name.eq_ignore_ascii_case(SERVER_NAME) || name.eq_ignore_ascii_case(LEGACY_SERVER_NAME) {
        return true;
    }
    if name.eq_ignore_ascii_case(OTHER_WORLD_SERVER_NAME)
        || name.eq_ignore_ascii_case(OTHER_WORLD_LEGACY_NAME)
    {
        return false;
    }
    // Codex's scanner hands over the table BODY as a JSON string; Claude and
    // Gemini hand over the entry object.
    let command = match value {
        serde_json::Value::String(body) => crate::toml_command_in(body),
        _ => crate::json_entry_command(value),
    };
    command.is_some_and(|c| c.to_ascii_lowercase().contains(ADAPTER_STEM))
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Where THIS build's adapter lives: beside the executable that is running.
///
/// One rule covers both layouts, which is why there is no configuration here.
/// The adapter is a second `[[bin]]` of this crate, so cargo writes it into the
/// same `target/<profile>/` directory as `made.exe` during development, and
/// Tauri's bundler installs every bin of the package into the app directory —
/// also beside `made.exe`. `current_exe().parent()` is therefore correct in
/// dev, in an NSIS install and in an MSI install alike.
///
/// `None` when it is not there. Answering with a path that does not exist would
/// make every `pathMatches` comparison a lie, and would register three CLIs
/// against a server that cannot launch.
pub fn adapter_exe_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let candidate = exe
        .parent()?
        .join(format!("{ADAPTER_STEM}{}", std::env::consts::EXE_SUFFIX));
    // Non-empty, not merely present: a truncated or half-written copy passes an
    // existence check and then dies on launch, which is the one failure mode
    // that would look like a working registration.
    let usable = std::fs::metadata(&candidate)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false);
    usable.then_some(candidate)
}

/// `C:\Users\x\p` → `/mnt/c/Users/x/p`. What a WSL-side CLI has to launch.
pub fn windows_to_wsl_path(path: &str) -> String {
    let slashed = path.replace('\\', "/");
    let mut chars = slashed.chars();
    match (chars.next(), chars.next(), chars.next()) {
        (Some(drive), Some(':'), Some('/')) if drive.is_ascii_alphabetic() => {
            format!("/mnt/{}{}", drive.to_ascii_lowercase(), &slashed[2..])
        }
        _ => slashed,
    }
}

/// Fold a path to a form two spellings of the same file share.
///
/// The same adapter is `C:\…\made-knowledge-mcp.exe` to a Windows CLI and
/// `/mnt/c/…/made-knowledge-mcp.exe` to a WSL one, and Windows does not care
/// about case. Comparing raw strings would report a mismatch on every WSL
/// install and send the user to "fix" a registration that is already right.
fn norm_adapter_path(path: &str) -> String {
    let mut text = path.trim().trim_matches('"').trim_matches('\'').to_string();
    text = text.replace('\\', "/").to_ascii_lowercase();
    if let Some(rest) = text.strip_prefix("/mnt/") {
        let mut chars = rest.chars();
        if let (Some(drive), Some('/')) = (chars.next(), chars.next()) {
            if drive.is_ascii_alphabetic() {
                text = format!("{drive}:{}", &rest[1..]);
            }
        }
    }
    text.trim_end_matches('/').to_string()
}

fn same_adapter(a: &str, b: &str) -> bool {
    norm_adapter_path(a) == norm_adapter_path(b)
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Read one CLI's config under a given home directory.
///
/// Structurally the same walk as `jira_mcp_status_for_home`, and deliberately
/// so — the difference is the matcher and the extra path comparison, not where
/// each CLI keeps its file.
fn status_for_home(
    cli: JiraCli,
    home: Option<PathBuf>,
    project_path: Option<String>,
    expected: Option<&Path>,
) -> KnowledgeMcpStatus {
    let matcher = &is_knowledge_entry;
    match cli {
        JiraCli::Claude => {
            // A committed `.mcp.json` counts wherever home is.
            if let Some(entry) = find_mcp_in_project_file(project_path.as_deref(), matcher) {
                return KnowledgeMcpStatus::found(entry, "project", expected);
            }
            let Some(home) = home else {
                return KnowledgeMcpStatus::unknown();
            };
            let Ok(raw) = std::fs::read_to_string(claude_json_at(&home)) else {
                return KnowledgeMcpStatus::unknown();
            };
            let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) else {
                return KnowledgeMcpStatus::unknown();
            };
            match find_mcp_in_claude_json(&doc, project_path.as_deref(), matcher) {
                Some((entry, scope)) => KnowledgeMcpStatus::found(entry, &scope, expected),
                None => KnowledgeMcpStatus::absent(),
            }
        }
        JiraCli::Codex => {
            // One global config; no project or local scope exists.
            let Some(home) = home else {
                return KnowledgeMcpStatus::unknown();
            };
            let raw = match std::fs::read_to_string(home.join(".codex").join("config.toml")) {
                Ok(raw) => raw,
                // Only a genuinely ABSENT file is a real "none configured" —
                // Codex writes its config on first `mcp add`. Any OTHER read
                // error (a permission denial, a non-UTF-8 byte, a flaky
                // \\wsl.localhost hop) means we could not look, and "could not
                // look" is Unknown. Treating it as absent is the one failure
                // this three-state contract exists to prevent: telling someone
                // to install what they already have.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound
                    && home.join(".codex").is_dir() =>
                {
                    return KnowledgeMcpStatus::absent()
                }
                Err(_) => return KnowledgeMcpStatus::unknown(),
            };
            match find_mcp_in_codex_toml(&raw, matcher) {
                Some(entry) => KnowledgeMcpStatus::found(entry, "user", expected),
                None => KnowledgeMcpStatus::absent(),
            }
        }
        JiraCli::Gemini => {
            // Project scope first: it is Gemini's default, and it wins for
            // panes opened in that folder.
            if let Some(dir) = project_path.as_deref() {
                let path = Path::new(dir).join(".gemini").join("settings.json");
                if let Some(entry) = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                    .and_then(|doc| find_mcp_in_gemini_settings(&doc, matcher))
                {
                    return KnowledgeMcpStatus::found(entry, "project", expected);
                }
            }
            let Some(home) = home else {
                return KnowledgeMcpStatus::unknown();
            };
            // Same rule as Codex above: absent means none configured, anything
            // else means we could not look.
            let raw = match std::fs::read_to_string(home.join(".gemini").join("settings.json")) {
                Ok(raw) => raw,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound
                    && home.join(".gemini").is_dir() =>
                {
                    return KnowledgeMcpStatus::absent()
                }
                Err(_) => return KnowledgeMcpStatus::unknown(),
            };
            let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) else {
                return KnowledgeMcpStatus::unknown();
            };
            match find_mcp_in_gemini_settings(&doc, matcher) {
                Some(entry) => KnowledgeMcpStatus::found(entry, "user", expected),
                None => KnowledgeMcpStatus::absent(),
            }
        }
    }
}

/// Is `made-knowledge` registered? — WSL.
#[tauri::command]
pub async fn knowledge_mcp_status(
    project_path: Option<String>,
    distro: Option<String>,
    cli: Option<String>,
) -> Result<KnowledgeMcpStatus, String> {
    let cli = JiraCli::parse(cli.as_deref());
    // The registration a WSL CLI holds names the adapter by its /mnt/c path, so
    // that is what this build's own path has to be compared as.
    let expected = adapter_exe_path().map(|p| PathBuf::from(windows_to_wsl_path(&p.to_string_lossy())));
    Ok(status_for_home(
        cli,
        resolve_wsl_home_for(cli, distro.as_deref()),
        project_path,
        expected.as_deref(),
    ))
}

/// Is `made-knowledge` registered? — Windows native.
#[tauri::command]
pub async fn knowledge_mcp_status_windows(
    project_path: Option<String>,
    cli: Option<String>,
) -> Result<KnowledgeMcpStatus, String> {
    let home = std::env::var("USERPROFILE").ok().map(PathBuf::from);
    let expected = adapter_exe_path();
    Ok(status_for_home(
        JiraCli::parse(cli.as_deref()),
        home,
        project_path,
        expected.as_deref(),
    ))
}

/// Is `made-knowledge` registered? — macOS/Linux native.
#[tauri::command]
pub async fn knowledge_mcp_status_native(
    project_path: Option<String>,
    cli: Option<String>,
) -> Result<KnowledgeMcpStatus, String> {
    let home = std::env::var("HOME").ok().map(PathBuf::from);
    let expected = adapter_exe_path();
    Ok(status_for_home(
        JiraCli::parse(cli.as_deref()),
        home,
        project_path,
        expected.as_deref(),
    ))
}

// ---------------------------------------------------------------------------
// Install / remove argv
// ---------------------------------------------------------------------------

/// The `mcp add` argv that registers the adapter with a given CLI.
///
/// User scope everywhere a scope exists, because one registration serves every
/// project — the adapter resolves which project it is in from its own working
/// directory. Note the two traps: Claude defaults to LOCAL scope and Gemini
/// defaults to PROJECT scope, so `--scope user` and `-s user` are both
/// load-bearing, and Codex has no scope flag at all.
///
/// `--agent <cli>` is the trusted identity: it is baked into the registration
/// here, where a model can never reach it.
fn add_args(cli: JiraCli, adapter: &str) -> Vec<String> {
    let owned = |parts: &[&str]| parts.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match cli {
        // `--` before the command, so the adapter's own flags are not parsed as
        // claude's.
        JiraCli::Claude => owned(&[
            "mcp", "add", "--scope", "user", SERVER_NAME, "--", adapter, "--agent", "claude",
        ]),
        JiraCli::Codex => owned(&[
            "mcp", "add", SERVER_NAME, "--", adapter, "--agent", "codex",
        ]),
        // Gemini takes the command as a positional and everything after it as
        // the command's args — no `--` separator in its grammar.
        JiraCli::Gemini => owned(&[
            "mcp", "add", "-s", "user", SERVER_NAME, adapter, "--agent", "gemini",
        ]),
    }
}

/// The `mcp remove` argv. Verified against each CLI's own `mcp remove --help`:
/// claude takes `--scope`, gemini takes `-s` (and defaults to project, so
/// omitting it would fail to remove a user-scope entry), codex takes neither.
///
/// Name and scope come from what DETECTION found, not from what install would
/// have written. Hardcoding `made-knowledge` at user scope meant an entry found
/// anywhere else could never be removed: the CLI reported "no such server", the
/// row still read as configured, and "Update registration" ran a remove that
/// could not work followed by an install that landed in a scope the existing
/// entry shadowed. An action that cannot succeed is worse than one that is not
/// offered.
fn remove_args(cli: JiraCli, name: &str, scope: &str) -> Vec<String> {
    let name = if name.trim().is_empty() { SERVER_NAME } else { name.trim() };
    let mut args = vec!["mcp".to_string(), "remove".to_string(), name.to_string()];
    // Scope reaches a CLI argv, so it is validated against what each CLI
    // actually accepts rather than passed through. An unrecognised value falls
    // back to `user` — the scope MADE installs to, and the only safe guess.
    match cli {
        JiraCli::Claude => {
            let scope = match scope.trim() {
                "local" => "local",
                "project" => "project",
                _ => "user",
            };
            args.push("--scope".into());
            args.push(scope.into());
        }
        // Gemini knows only user|project. A Claude-style "local" has no meaning
        // here and must not be forwarded.
        JiraCli::Gemini => {
            let scope = if scope.trim() == "project" { "project" } else { "user" };
            args.push("-s".into());
            args.push(scope.into());
        }
        // One global config; no scope flag exists.
        JiraCli::Codex => {}
    }
    args
}

/// Single-quote for `bash -lic`. The adapter path is the only value in the
/// command line that MADE did not write as a literal.
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// One bounded shell command line for the WSL path.
///
/// `test` as well as `windows` in the cfg: the argv this builds is worth
/// pinning on every platform's CI, even where the code path can never run.
///
/// The bound is applied INSIDE the distro with `timeout`, not by killing the
/// wsl.exe relay from the Windows side — killing the relay would not reliably
/// reap the CLI process it started.
#[cfg(any(target_os = "windows", test))]
fn wsl_script(cli: JiraCli, args: &[String]) -> String {
    let quoted: Vec<String> = args
        .iter()
        .map(|a| {
            // Everything but the adapter path is a compile-time literal; quote
            // only what needs it, so the command stays readable in a log.
            if a.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
                a.clone()
            } else {
                sh_quote(a)
            }
        })
        .collect();
    format!(
        "timeout {DEADLINE_SECS} {} {} 2>&1",
        cli.binary(),
        quoted.join(" ")
    )
}

fn timeout_error(cli: JiraCli, verb: &str) -> String {
    format!(
        "{} mcp {verb} did not finish in {DEADLINE_SECS}s — is WSL responding? Nothing was changed.",
        cli.binary()
    )
}

#[cfg(target_os = "windows")]
fn adapter_for_wsl() -> Result<String, String> {
    let path = adapter_exe_path().ok_or_else(|| {
        format!("{ADAPTER_STEM} is not installed next to MADE — reinstall MADE and try again.")
    })?;
    Ok(windows_to_wsl_path(&path.to_string_lossy()))
}

fn adapter_for_direct() -> Result<String, String> {
    let path = adapter_exe_path().ok_or_else(|| {
        format!("{ADAPTER_STEM} is not installed next to MADE — reinstall MADE and try again.")
    })?;
    Ok(path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Install / remove commands
// ---------------------------------------------------------------------------

/// CLIs with a registration command running right now.
///
/// Every `mcp add` / `mcp remove` is a read-modify-write of that CLI's own
/// config file, and none of them lock it: two running at once means the later
/// writer discards whatever the first one — or a live pane — put there. The UI
/// disables its buttons, but UI state is not mutual exclusion; a slow WSL boot,
/// a second window, or a retry after a frontend timeout all reach here anyway.
/// The guard belongs where the process is.
fn in_flight() -> &'static std::sync::Mutex<Vec<&'static str>> {
    static IN_FLIGHT: std::sync::OnceLock<std::sync::Mutex<Vec<&'static str>>> =
        std::sync::OnceLock::new();
    IN_FLIGHT.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// Releases the claim on drop, so an early `?` cannot strand it.
#[derive(Debug)]
struct CliClaim(&'static str);

impl CliClaim {
    fn acquire(cli: JiraCli, verb: &str) -> Result<Self, String> {
        let binary = cli.binary();
        let mut held = in_flight().lock().map_err(|_| "registration lock poisoned".to_string())?;
        if held.contains(&binary) {
            return Err(format!(
                "a {binary} registration is already running — wait for it to finish before \
                 starting another {verb}."
            ));
        }
        held.push(binary);
        Ok(Self(binary))
    }
}

impl Drop for CliClaim {
    fn drop(&mut self) {
        if let Ok(mut held) = in_flight().lock() {
            held.retain(|b| *b != self.0);
        }
    }
}

/// Register the adapter with a CLI — WSL.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn knowledge_mcp_install(
    distro: Option<String>,
    cli: Option<String>,
) -> Result<String, String> {
    let kind = JiraCli::parse(cli.as_deref());
    let _claim = CliClaim::acquire(kind, "install")?;
    run_in_wsl(kind, distro, &add_args(kind, &adapter_for_wsl()?), "add")
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn knowledge_mcp_install(
    _distro: Option<String>,
    _cli: Option<String>,
) -> Result<String, String> {
    Err("WSL is only available on Windows".to_string())
}

/// Unregister — WSL.
///
/// `name` and `scope` describe the entry DETECTION found; both default to what
/// install writes, so a caller that omits them keeps the old behaviour.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn knowledge_mcp_remove(
    distro: Option<String>,
    cli: Option<String>,
    name: Option<String>,
    scope: Option<String>,
) -> Result<String, String> {
    let kind = JiraCli::parse(cli.as_deref());
    let _claim = CliClaim::acquire(kind, "removal")?;
    let args = remove_args(
        kind,
        name.as_deref().unwrap_or(SERVER_NAME),
        scope.as_deref().unwrap_or("user"),
    );
    run_in_wsl(kind, distro, &args, "remove")
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn knowledge_mcp_remove(
    _distro: Option<String>,
    _cli: Option<String>,
    _name: Option<String>,
    _scope: Option<String>,
) -> Result<String, String> {
    Err("WSL is only available on Windows".to_string())
}

#[cfg(target_os = "windows")]
fn run_in_wsl(
    cli: JiraCli,
    distro: Option<String>,
    args: &[String],
    verb: &str,
) -> Result<String, String> {
    let script = wsl_script(cli, args);
    let out = crate::wsl_command_in(distro.as_deref().filter(|d| !d.trim().is_empty()))
        .arg("--")
        .arg("bash")
        .arg("-lic")
        .arg(&script)
        .output()
        .map_err(|e| format!("could not run wsl.exe: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        return Ok(text);
    }
    // 124 is `timeout`'s "I killed it". Unlike the Atlassian path there is no
    // OAuth flow that legitimately hangs after the write, so this is a failure
    // for every CLI.
    if out.status.code() == Some(124) {
        return Err(timeout_error(cli, verb));
    }
    // wsl.exe's OWN failures — no such distro, WSL not installed, the VM
    // refusing to start — happen BEFORE bash exists, so the script's `2>&1`
    // catches nothing and stdout is empty. Reporting the generic message there
    // throws away the only sentence that says what actually went wrong.
    let relay = wsl_relay_text(&out.stderr);
    Err(if !text.is_empty() {
        text
    } else if !relay.is_empty() {
        relay
    } else {
        format!("{} mcp {verb} failed", cli.binary())
    })
}

/// Decode bytes that may have come from wsl.exe itself rather than from the
/// Linux process it relays.
///
/// wsl.exe's OWN diagnostics are UTF-16LE (the same trap `wsl_list_distros`
/// documents) — decoding them as UTF-8 yields NUL-interleaved garbage, which is
/// worse than no message at all. Anything a relayed process wrote is ordinary
/// bytes. An interior NUL is the tell, since no UTF-8 diagnostic contains one.
///
/// `test` as well as `windows`: the decoding is worth pinning on every
/// platform's CI, even where the only caller cannot run.
#[cfg(any(target_os = "windows", test))]
fn wsl_relay_text(bytes: &[u8]) -> String {
    if bytes.contains(&0) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units).trim().to_string()
    } else {
        String::from_utf8_lossy(bytes).trim().to_string()
    }
}

/// Register — Windows native / macOS / Linux, where the CLI runs directly.
#[tauri::command]
pub async fn knowledge_mcp_install_direct(
    cli_path: Option<String>,
    cli: Option<String>,
) -> Result<String, String> {
    let kind = JiraCli::parse(cli.as_deref());
    let _claim = CliClaim::acquire(kind, "install")?;
    run_direct(kind, cli_path, &add_args(kind, &adapter_for_direct()?), "add")
}

/// Unregister — Windows native / macOS / Linux. See `knowledge_mcp_remove` for
/// what `name` and `scope` mean.
#[tauri::command]
pub async fn knowledge_mcp_remove_direct(
    cli_path: Option<String>,
    cli: Option<String>,
    name: Option<String>,
    scope: Option<String>,
) -> Result<String, String> {
    let kind = JiraCli::parse(cli.as_deref());
    let _claim = CliClaim::acquire(kind, "removal")?;
    let args = remove_args(
        kind,
        name.as_deref().unwrap_or(SERVER_NAME),
        scope.as_deref().unwrap_or("user"),
    );
    run_direct(kind, cli_path, &args, "remove")
}

fn run_direct(
    cli: JiraCli,
    cli_path: Option<String>,
    args: &[String],
    verb: &str,
) -> Result<String, String> {
    let program = cli_path
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| cli.binary().to_string());
    let child = Command::new(&program)
        .args(args)
        // Null stdin so a CLI that decides to prompt gets EOF and exits, rather
        // than waiting forever on a terminal that does not exist here.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {program}: {e}"))?;
    let Some(out) = wait_for_mcp_add(child, Duration::from_secs(DEADLINE_SECS))? else {
        return Err(timeout_error(cli, verb));
    };
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok(if text.is_empty() { err } else { text })
    } else {
        // The CLI's own words when it has any — "command not found" and
        // "unknown flag" both beat anything invented here.
        Err(if err.is_empty() {
            format!("{program} mcp {verb} failed")
        } else {
            err
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_renamed_server_is_still_recognised_by_its_command() {
        // Exact name, any casing.
        assert!(is_knowledge_entry(SERVER_NAME, &json!({})));
        assert!(is_knowledge_entry(&SERVER_NAME.to_ascii_uppercase(), &json!({})));
        // The OTHER world's entry is never ours — even when its command runs
        // an adapter with our stem. Claiming it is how a debug build would
        // uproot the live registration.
        assert!(!is_knowledge_entry(OTHER_WORLD_SERVER_NAME, &json!({})));
        assert!(!is_knowledge_entry(
            OTHER_WORLD_SERVER_NAME,
            &json!({ "command": "C:\\Program Files\\MADE\\made-knowledge-mcp.exe" })
        ));
        // Legacy spellings (pre made-nexus rename): our world's is OURS so the
        // Update repair can migrate it; the other world's stays untouchable.
        assert!(is_knowledge_entry(LEGACY_SERVER_NAME, &json!({})));
        assert!(!is_knowledge_entry(OTHER_WORLD_LEGACY_NAME, &json!({})));
        // Renamed, but launching our adapter.
        assert!(is_knowledge_entry(
            "project-memory",
            &json!({ "command": "C:\\Program Files\\MADE\\made-knowledge-mcp.exe" })
        ));
        assert!(is_knowledge_entry(
            "mem",
            &json!({ "command": "/mnt/c/made/MADE-KNOWLEDGE-MCP.EXE" })
        ));
        // Somebody else's server.
        assert!(!is_knowledge_entry("blender", &json!({ "command": "uvx" })));
        assert!(!is_knowledge_entry(
            "atlassian",
            &json!({ "url": "https://mcp.atlassian.com/v1/mcp/authv2" })
        ));
    }

    /// The matcher may only claim an entry whose LAUNCH COMMAND is our adapter.
    ///
    /// It used to match any mention of the stem anywhere in the serialized
    /// entry, which claimed third-party servers that merely reference the
    /// binary — a wrapper script, a bridge, a path in `args`. The damage was
    /// not cosmetic: the row reported someone else's server as MADE's, offered
    /// to remove it, and because the scan returns the first hit it never
    /// offered Install again, leaving a state no button could leave.
    #[test]
    fn a_server_that_merely_mentions_the_adapter_is_not_ours() {
        // A wrapper: `command` is node, our stem appears only in the args.
        assert!(!is_knowledge_entry(
            "aaa-bridge",
            &json!({ "command": "node", "args": ["/opt/aaa/made-knowledge-mcp-bridge.js"] })
        ));
        // A path mentioned in an env var is not a launch either.
        assert!(!is_knowledge_entry(
            "watcher",
            &json!({ "command": "watchexec", "env": { "TARGET": "made-knowledge-mcp.exe" } })
        ));
        // Codex hands the scanner a table BODY as a JSON string, so the String
        // arm has to reach the same conclusion.
        assert!(!is_knowledge_entry(
            "aaa-bridge",
            &json!("command = \"node\"\nargs = [\"/opt/aaa/made-knowledge-mcp-bridge.js\"]\n")
        ));
        assert!(is_knowledge_entry(
            "renamed",
            &json!("command = \"C:\\\\made\\\\made-knowledge-mcp.exe\"\nargs = [\"--agent\"]\n")
        ));

        // The two ways an entry IS ours still hold.
        assert!(is_knowledge_entry(SERVER_NAME, &json!({})));
        assert!(is_knowledge_entry(
            "project-memory",
            &json!({ "command": "/mnt/c/made/made-knowledge-mcp.exe", "args": ["--agent", "claude"] })
        ));
    }

    /// An unreadable config is UNKNOWN, never "not set up".
    ///
    /// Codex and Gemini both write their config on first `mcp add`, so a
    /// missing file really does mean none configured — but the old code reached
    /// that conclusion from ANY read error, including a permission denial or a
    /// dropped `\\wsl.localhost` hop. That renders as "Not set up" and invites
    /// the user to install what they may already have.
    #[test]
    fn an_unreadable_config_is_unknown_not_missing() {
        for (cli, dir, file) in [
            (JiraCli::Codex, ".codex", "config.toml"),
            (JiraCli::Gemini, ".gemini", "settings.json"),
        ] {
            // Readable and holding no such server: a real, CHECKED "no".
            let readable = crate::knowledge::testutil::TestDir::new();
            let cfg_dir = readable.path().join(dir);
            std::fs::create_dir_all(&cfg_dir).expect("mkdir");
            std::fs::write(cfg_dir.join(file), "{}").expect("write");
            let ok = status_for_home(cli, Some(readable.path().to_path_buf()), None, None);
            assert!(ok.checked, "{dir}: a readable config must be an answer");
            assert!(!ok.configured);

            // Present but unreadable. A DIRECTORY where the config file should
            // be is the portable way to produce a non-NotFound read error —
            // the real cases are a permission denial or a dropped
            // \\wsl.localhost hop, which no test can stage on both platforms.
            let blocked = crate::knowledge::testutil::TestDir::new();
            std::fs::create_dir_all(blocked.path().join(dir).join(file)).expect("mkdir");
            let read_err = std::fs::read_to_string(blocked.path().join(dir).join(file))
                .expect_err("a directory must not read as a file");
            assert_ne!(
                read_err.kind(),
                std::io::ErrorKind::NotFound,
                "this test only means something if the error is NOT NotFound"
            );

            let status = status_for_home(cli, Some(blocked.path().to_path_buf()), None, None);
            assert!(
                !status.checked,
                "{dir}: could-not-look reported as checked={} configured={} — that renders as \
                 \"Not set up\" and tells the user to install what they may already have",
                status.checked, status.configured
            );
            assert!(!status.configured);
        }
    }

    /// The config directory exists but the file does not: that IS "none
    /// configured", and must stay so — it is the state a fresh CLI install is
    /// in, and reporting Unknown there would never offer Install.
    #[test]
    fn a_missing_file_under_an_existing_config_dir_is_a_real_no() {
        for (cli, dir) in [(JiraCli::Codex, ".codex"), (JiraCli::Gemini, ".gemini")] {
            let home = crate::knowledge::testutil::TestDir::new();
            std::fs::create_dir_all(home.path().join(dir)).expect("mkdir");
            let status = status_for_home(cli, Some(home.path().to_path_buf()), None, None);
            assert!(status.checked, "{dir}: a missing file is an answer");
            assert!(!status.configured);
        }

        // No config directory at all means the CLI has never run here, which is
        // not the same as having run and configured nothing.
        for cli in [JiraCli::Codex, JiraCli::Gemini] {
            let home = crate::knowledge::testutil::TestDir::new();
            let status = status_for_home(cli, Some(home.path().to_path_buf()), None, None);
            assert!(!status.checked, "{}: never-run must be unknown", cli.binary());
        }
    }

    /// wsl.exe's own failures are UTF-16LE and arrive on stderr, before bash
    /// exists to be redirected. Decoding them as UTF-8 produces NUL-interleaved
    /// garbage, which is worse than the generic message it would replace.
    #[test]
    fn wsl_relay_text_decodes_both_encodings() {
        let msg = "There is no distribution with the supplied name.";
        let utf16: Vec<u8> = msg.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(wsl_relay_text(&utf16), msg);

        // A relayed Linux process writes ordinary bytes.
        assert_eq!(wsl_relay_text(b"  bash: claude: command not found\n"), "bash: claude: command not found");
        assert_eq!(wsl_relay_text(b""), "");
        // Odd trailing byte must not panic.
        assert!(!wsl_relay_text(&[0x41, 0x00, 0x42]).is_empty());
    }

    /// Two registrations for the same CLI at once are two writers on one config
    /// file, and none of the CLIs lock it. UI button state is not mutual
    /// exclusion — a retry, a second window, or a slow WSL boot all get past it.
    #[test]
    fn one_registration_per_cli_at_a_time() {
        let first = CliClaim::acquire(JiraCli::Claude, "install").expect("first claim");
        let blocked = CliClaim::acquire(JiraCli::Claude, "removal");
        assert!(blocked.is_err(), "a second claude write was allowed through");
        assert!(blocked.unwrap_err().contains("already running"));

        // A different CLI writes a different file and is unaffected.
        let other = CliClaim::acquire(JiraCli::Codex, "install").expect("codex is independent");
        drop(other);

        // Released on drop, including on an early `?` return.
        drop(first);
        let again = CliClaim::acquire(JiraCli::Claude, "install");
        assert!(again.is_ok(), "the claim was never released");
    }

    #[test]
    fn a_windows_path_and_its_wsl_twin_are_the_same_adapter() {
        // The whole point: the SAME file, as a Windows CLI and a WSL CLI each
        // have to name it. Comparing raw strings would flag every WSL install
        // as pointing at a different MADE.
        assert!(same_adapter(
            r"C:\Program Files\MADE\made-knowledge-mcp.exe",
            "/mnt/c/Program Files/MADE/made-knowledge-mcp.exe"
        ));
        assert!(same_adapter(
            r"c:\made\made-knowledge-mcp.exe",
            r"C:\MADE\made-knowledge-mcp.exe"
        ));
        assert!(same_adapter(
            "\"C:/made/made-knowledge-mcp.exe\"",
            "C:/made/made-knowledge-mcp.exe"
        ));
        // A genuinely different install must still read as different, or the
        // repair action never appears.
        assert!(!same_adapter(
            r"C:\made\made-knowledge-mcp.exe",
            r"D:\made\made-knowledge-mcp.exe"
        ));
        assert!(!same_adapter(
            r"C:\made-old\made-knowledge-mcp.exe",
            r"C:\made\made-knowledge-mcp.exe"
        ));
    }

    #[test]
    fn windows_paths_translate_to_the_wsl_mount() {
        assert_eq!(windows_to_wsl_path(r"C:\made\x.exe"), "/mnt/c/made/x.exe");
        assert_eq!(windows_to_wsl_path(r"D:\a\b"), "/mnt/d/a/b");
        // Already a POSIX path, or a UNC share: leave it alone rather than
        // mangle it into something that does not exist.
        assert_eq!(windows_to_wsl_path("/usr/local/bin/x"), "/usr/local/bin/x");
        assert_eq!(
            windows_to_wsl_path(r"\\wsl.localhost\Ubuntu\home\u"),
            "//wsl.localhost/Ubuntu/home/u"
        );
    }

    #[test]
    fn each_cli_gets_the_scope_flag_it_actually_needs() {
        let adapter = "/mnt/c/made/made-knowledge-mcp.exe";

        // Claude defaults to LOCAL scope — without --scope user the server is
        // registered only for whatever directory the install ran in.
        let claude = add_args(JiraCli::Claude, adapter);
        assert_eq!(
            claude,
            vec![
                "mcp", "add", "--scope", "user", SERVER_NAME, "--", adapter, "--agent",
                "claude"
            ]
        );
        // `--` must come BEFORE the adapter path, or `--agent` is parsed as one
        // of claude's own flags.
        let dashdash = claude.iter().position(|a| a == "--").expect("separator");
        assert!(dashdash < claude.iter().position(|a| a == adapter).unwrap());

        // Codex has no scope flag at all.
        assert_eq!(
            add_args(JiraCli::Codex, adapter),
            vec!["mcp", "add", SERVER_NAME, "--", adapter, "--agent", "codex"]
        );

        // Gemini defaults to PROJECT scope, and takes the command as a
        // positional with no separator.
        let gemini = add_args(JiraCli::Gemini, adapter);
        assert_eq!(
            gemini,
            vec![
                "mcp", "add", "-s", "user", SERVER_NAME, adapter, "--agent", "gemini"
            ]
        );
        assert!(!gemini.contains(&"--".to_string()));

        // Every add bakes in the agent kind: it is the one piece of identity a
        // model can never reach, and it only exists because it is written here.
        for cli in [JiraCli::Claude, JiraCli::Codex, JiraCli::Gemini] {
            let args = add_args(cli, adapter);
            let at = args.iter().position(|a| a == "--agent").expect("--agent");
            assert_eq!(args[at + 1], cli.binary());
        }
    }

    /// Live and debug builds register under DIFFERENT names — that is the
    /// isolation itself, so it is pinned: a debug build losing its `-dev`
    /// suffix would silently reclaim the live registration and put production
    /// panes back on the debug adapter (the 2026-08-07 incident).
    #[test]
    fn the_server_name_carries_the_per_build_world() {
        let expected = if cfg!(debug_assertions) {
            "made-nexus-dev"
        } else {
            "made-nexus"
        };
        assert_eq!(SERVER_NAME, expected);
        // The folder and the database directory split with it — one world,
        // three names, never mixed.
        let memory = if cfg!(debug_assertions) {
            ".project-memory-dev"
        } else {
            ".project-memory"
        };
        assert_eq!(crate::knowledge::projector::MEMORY_DIR, memory);
    }

    #[test]
    fn removes_target_the_same_scope_the_installs_wrote() {
        // Verified against each CLI's own `mcp remove --help`. Gemini's remove
        // defaults to project scope just like its add, so dropping `-s user`
        // would silently fail to remove a user-scope entry.
        assert_eq!(
            remove_args(JiraCli::Claude, SERVER_NAME, "user"),
            vec!["mcp", "remove", SERVER_NAME, "--scope", "user"]
        );
        assert_eq!(
            remove_args(JiraCli::Codex, SERVER_NAME, "user"),
            vec!["mcp", "remove", SERVER_NAME]
        );
        assert_eq!(
            remove_args(JiraCli::Gemini, SERVER_NAME, "user"),
            vec!["mcp", "remove", SERVER_NAME, "-s", "user"]
        );
    }

    /// A registration found somewhere other than where install writes has to be
    /// removable, or the row offers a repair that cannot work: the CLI reports
    /// "no such server", detection still sees the entry, and "Update
    /// registration" loops forever.
    #[test]
    fn removal_targets_the_entry_detection_actually_found() {
        assert_eq!(
            remove_args(JiraCli::Claude, "project-memory", "project"),
            vec!["mcp", "remove", "project-memory", "--scope", "project"]
        );
        assert_eq!(
            remove_args(JiraCli::Claude, SERVER_NAME, "local"),
            vec!["mcp", "remove", SERVER_NAME, "--scope", "local"]
        );
        assert_eq!(
            remove_args(JiraCli::Gemini, SERVER_NAME, "project"),
            vec!["mcp", "remove", SERVER_NAME, "-s", "project"]
        );
        // Codex has one global config, so a scope it never had is simply not
        // passed rather than invented.
        assert_eq!(
            remove_args(JiraCli::Codex, "mem", "project"),
            vec!["mcp", "remove", "mem"]
        );

        // Scope reaches a CLI argv, so it is validated rather than forwarded.
        // "local" is Claude-only; Gemini knows user|project and must not be
        // handed a word it will reject.
        assert_eq!(
            remove_args(JiraCli::Gemini, SERVER_NAME, "local"),
            vec!["mcp", "remove", SERVER_NAME, "-s", "user"]
        );
        for junk in ["", "  ", "USER", "--force", "user; rm -rf ~"] {
            assert_eq!(
                remove_args(JiraCli::Claude, SERVER_NAME, junk),
                vec!["mcp", "remove", SERVER_NAME, "--scope", "user"],
                "scope {junk:?} was not rejected"
            );
        }
        // An empty name falls back rather than removing "" — which for Claude
        // would be a positional the CLI reads as a missing argument.
        assert_eq!(
            remove_args(JiraCli::Codex, "   ", "user"),
            vec!["mcp", "remove", SERVER_NAME]
        );
    }

    #[test]
    fn every_wsl_command_is_bounded_and_quotes_the_only_variable_value() {
        for cli in [JiraCli::Claude, JiraCli::Codex, JiraCli::Gemini] {
            let script = wsl_script(cli, &add_args(cli, "/mnt/c/made/made-knowledge-mcp.exe"));
            assert!(
                script.starts_with(&format!("timeout {DEADLINE_SECS} {}", cli.binary())),
                "{script}"
            );
            assert!(script.ends_with("2>&1"), "{script}");
            let removal = wsl_script(cli, &remove_args(cli, SERVER_NAME, "user"));
            assert!(removal.starts_with("timeout "), "{removal}");
        }

        // A path with a space or a quote is the one caller-influenced value in
        // the whole line — it reaches a bash command line and must survive as
        // one word.
        let nasty = "/mnt/c/Program Files/it's here/made-knowledge-mcp.exe";
        let script = wsl_script(JiraCli::Claude, &add_args(JiraCli::Claude, nasty));
        assert!(
            script.contains(r"'/mnt/c/Program Files/it'\''s here/made-knowledge-mcp.exe'"),
            "{script}"
        );
        // Flags stay unquoted so the line is still readable in a log.
        assert!(
            script.contains(&format!(" --scope user {SERVER_NAME} -- ")),
            "{script}"
        );
    }

    #[test]
    fn a_missing_config_reads_as_unknown_and_never_as_missing() {
        // Telling someone to install what they already have is worse than
        // saying nothing, so an unreadable config must not claim an answer.
        let unknown = KnowledgeMcpStatus::unknown();
        assert!(!unknown.checked);
        assert!(!unknown.configured);
        assert!(unknown.path_matches.is_none());

        // No home at all: unknown for every CLI, never "not set up".
        for cli in [JiraCli::Claude, JiraCli::Codex, JiraCli::Gemini] {
            let status = status_for_home(cli, None, None, None);
            assert!(!status.checked, "{} claimed an answer", cli.binary());
        }

        let absent = KnowledgeMcpStatus::absent();
        assert!(absent.checked && !absent.configured);
    }

    #[test]
    fn a_registration_pointing_at_another_made_is_reported_as_a_mismatch() {
        let ours = PathBuf::from(r"C:\Program Files\MADE\made-knowledge-mcp.exe");

        let matching = KnowledgeMcpStatus::found(
            McpEntry {
                name: SERVER_NAME.into(),
                command: Some("/mnt/c/Program Files/MADE/made-knowledge-mcp.exe".into()),
            },
            "user",
            Some(&ours),
        );
        assert!(matching.configured && matching.checked);
        assert_eq!(matching.path_matches, Some(true));

        let stale = KnowledgeMcpStatus::found(
            McpEntry {
                name: SERVER_NAME.into(),
                command: Some(r"C:\Users\x\AppData\Local\MADE-old\made-knowledge-mcp.exe".into()),
            },
            "user",
            Some(&ours),
        );
        assert_eq!(stale.path_matches, Some(false), "a moved MADE must show up");
        assert!(stale.registered_path.is_some(), "the UI has to name the other path");

        // Nothing to compare against is NOT a mismatch — same rule as `checked`.
        let no_expectation = KnowledgeMcpStatus::found(
            McpEntry {
                name: SERVER_NAME.into(),
                command: Some("whatever".into()),
            },
            "user",
            None,
        );
        assert_eq!(no_expectation.path_matches, None);
        let no_command = KnowledgeMcpStatus::found(
            McpEntry {
                name: SERVER_NAME.into(),
                command: None,
            },
            "user",
            Some(&ours),
        );
        assert_eq!(no_command.path_matches, None);
    }

    #[test]
    fn the_status_payload_uses_the_field_names_the_frontend_reads() {
        // `src/lib/knowledge/mcp.ts` reads these exact keys off the invoke
        // result. A rename here is a silently-undefined property in a render,
        // not a compile error on either side.
        let value = serde_json::to_value(KnowledgeMcpStatus::found(
            McpEntry {
                name: SERVER_NAME.into(),
                command: Some("C:/made/made-knowledge-mcp.exe".into()),
            },
            "user",
            Some(Path::new("C:/made/made-knowledge-mcp.exe")),
        ))
        .expect("serialize");
        for key in ["configured", "scope", "name", "checked", "registeredPath", "pathMatches"] {
            assert!(value.get(key).is_some(), "missing `{key}`: {value}");
        }
        assert_eq!(value["configured"], true);
        assert_eq!(value["pathMatches"], true);

        // The unknown state must not publish a pathMatches at all.
        let unknown = serde_json::to_value(KnowledgeMcpStatus::unknown()).expect("serialize");
        assert_eq!(unknown["checked"], false);
        assert!(unknown.get("pathMatches").is_none());
    }

    #[test]
    fn each_cli_config_format_is_scanned_for_the_adapter_command() {
        // Codex TOML, in the shape `codex mcp add -- <path> --agent codex`
        // writes, with an unrelated server and a sub-table alongside.
        // Fixtures carry the PER-BUILD name — in a debug build these configs
        // hold `made-knowledge-dev`, because that is the only entry a debug
        // build is allowed to recognise (live/dev isolation).
        let toml = format!(
            "[mcp_servers.blender]\ncommand = \"uvx\"\n\n\
             [mcp_servers.blender.env]\nX = \"1\"\n\n\
             [mcp_servers.{SERVER_NAME}]\n\
             command = \"C:\\\\Program Files\\\\MADE\\\\made-knowledge-mcp.exe\"\n\
             args = [\"--agent\", \"codex\"]\n"
        );
        let entry = find_mcp_in_codex_toml(&toml, &is_knowledge_entry).expect("codex entry");
        assert_eq!(entry.name, SERVER_NAME);
        assert_eq!(
            entry.command.as_deref(),
            Some(r"C:\Program Files\MADE\made-knowledge-mcp.exe"),
            "TOML escapes backslashes and a Windows path is all backslashes"
        );

        // Gemini settings, at whatever depth its schema has moved to.
        let gemini: serde_json::Value = serde_json::from_str(&format!(
            r#"{{"general":{{"x":1}},"mcpServers":{{"{SERVER_NAME}":{{"command":"/mnt/c/made/made-knowledge-mcp.exe","args":["--agent","gemini"]}}}}}}"#,
        ))
        .unwrap();
        let entry = find_mcp_in_gemini_settings(&gemini, &is_knowledge_entry).expect("gemini");
        assert_eq!(entry.command.as_deref(), Some("/mnt/c/made/made-knowledge-mcp.exe"));

        // Claude's user scope.
        let claude: serde_json::Value = serde_json::from_str(&format!(
            r#"{{"mcpServers":{{"{SERVER_NAME}":{{"type":"stdio","command":"/mnt/c/made/made-knowledge-mcp.exe","args":["--agent","claude"]}}}}}}"#,
        ))
        .unwrap();
        let (entry, scope) =
            find_mcp_in_claude_json(&claude, None, &is_knowledge_entry).expect("claude");
        assert_eq!(scope, "user");
        assert_eq!(entry.command.as_deref(), Some("/mnt/c/made/made-knowledge-mcp.exe"));

        // A config holding only other servers is a clean "no".
        assert!(find_mcp_in_codex_toml("[mcp_servers.blender]\ncommand = \"uvx\"\n", &is_knowledge_entry).is_none());
        assert!(find_mcp_in_gemini_settings(&json!({ "mcpServers": {} }), &is_knowledge_entry).is_none());
    }
}

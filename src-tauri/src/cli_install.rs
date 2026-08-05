//! Install a missing AI CLI (claude / codex / gemini) on the backend a pane is
//! actually going to run on, streaming the installer's output back live.
//!
//! Opening a Codex pane on a machine without Codex used to produce a dead
//! terminal — `zsh:1: command not found: codex` and nothing else. MADE already
//! knows which CLIs resolve where (`wsl_resolve_cli_env`,
//! `windows_resolve_cli_env`, `native_resolve_cli_env`, `ssh_detect_cli_shells`);
//! this module is the other half: confirm the absence (`cli_probe`) and then
//! fix it (`cli_install_start`).
//!
//! # Why a stream and not a one-shot
//!
//! `npm install -g` and the Claude installer take tens of seconds and print
//! their progress to stderr. A blocking command would hand the UI one string
//! after two silent minutes, which is indistinguishable from a hang. So the
//! child's stdout AND stderr are pushed line-by-line down a `Channel<String>`
//! and the modal shows them as they arrive.
//!
//! # Rules baked in here
//!
//! - **`async fn`, and the real work on a `std::thread`.** A plain sync
//!   `#[tauri::command]` runs INLINE on the WebView2 UI thread: a two-minute
//!   install would freeze every other command and every cross-webview eval.
//! - **`stdin` is null.** An installer that decides to prompt gets EOF and
//!   exits instead of waiting forever on a terminal that does not exist.
//! - **Interactive login shell on Unix** (`bash -lic`, `<shell> -lic` over SSH).
//!   npm usually comes from nvm, which only exists in an interactive login
//!   shell — the same reason `remote-cli-shells.ts` exists. It is also what
//!   makes the freshly installed `~/.local/bin/claude` resolvable on the
//!   re-probe immediately afterwards.
//! - **Claude gets ONE fallback.** Its native installer needs `curl`; when that
//!   fails (no curl, a 403, a musl box with no bash) the ladder drops to
//!   `npm install -g @anthropic-ai/claude-code` in the same streamed session and
//!   says so in the log. Codex and Gemini ship only on npm, so they have no
//!   second rung.
//!
//! Cancelling kills the local child (`wsl.exe` / `ssh` / `npm`). A remote
//! installer already past the handshake may still finish on the server — the
//! re-probe after a cancel is therefore still worth trusting over the cancel.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Mutex, OnceLock,
};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;

/// Hard ceiling for one install step. A cold `npm install -g` on a slow remote
/// box is minutes, not seconds; anything past this is wedged, not slow.
const STEP_DEADLINE: Duration = Duration::from_secs(600);

/// Bound on a probe. `command -v` is instant; this only covers WSL booting a
/// stopped VM or an SSH host that accepts the connection and then stalls.
const PROBE_DEADLINE: Duration = Duration::from_secs(45);

/// Exit code reported when the user cancels. Matches the shell convention for
/// "terminated by SIGINT" so the frontend can tell it apart from a real failure.
const EXIT_CANCELLED: i32 = 130;

/// Exit code reported when a step could not even be spawned (no `bash`, no
/// `ssh.exe`). Shell convention for "command not found".
const EXIT_NOT_SPAWNED: i32 = 127;

// ─────────────────────────────────────────────────────────────────────────────
// The CLIs and their install commands
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AiCli {
    Claude,
    Codex,
    Gemini,
}

impl AiCli {
    fn parse(s: &str) -> Result<Self, String> {
        match s {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "gemini" => Ok(Self::Gemini),
            other => Err(format!("unknown CLI: {other}")),
        }
    }

    /// The executable name to look for on PATH.
    fn binary(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
        }
    }

    fn npm_package(self) -> &'static str {
        match self {
            Self::Claude => "@anthropic-ai/claude-code",
            Self::Codex => "@openai/codex",
            Self::Gemini => "@google/gemini-cli",
        }
    }
}

/// Install commands for a Unix-ish target (WSL, macOS, Linux, SSH), in ladder
/// order: try the first, and only on failure try the next.
fn unix_ladder(cli: AiCli) -> Vec<String> {
    let npm = format!("npm install -g {}", cli.npm_package());
    match cli {
        // Native installer first: it needs no Node at all, which is the
        // likeliest thing to be missing on a remote box, and it self-updates
        // afterwards.
        AiCli::Claude => vec![
            "curl -fsSL https://claude.ai/install.sh | bash".to_string(),
            npm,
        ],
        AiCli::Codex | AiCli::Gemini => vec![npm],
    }
}

/// Same ladder for native Windows. The Claude installer is a PowerShell
/// one-liner there, and npm has to be reached as `npm.cmd` through `cmd /C`
/// (PATHEXT resolution — `Command::new("npm")` finds nothing).
fn windows_ladder(cli: AiCli) -> Vec<String> {
    let npm = format!("npm install -g {}", cli.npm_package());
    match cli {
        AiCli::Claude => vec!["irm https://claude.ai/install.ps1 | iex".to_string(), npm],
        AiCli::Codex | AiCli::Gemini => vec![npm],
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Targets
// ─────────────────────────────────────────────────────────────────────────────

enum Target {
    Wsl {
        distro: Option<String>,
    },
    Windows,
    Native,
    Ssh {
        host: String,
        username: String,
        identity_file: String,
        /// Login shell probed by `ssh_detect_cli_shells` — the one that can see
        /// the user's real PATH. Allowlisted before it reaches a command line.
        shell: String,
    },
}

/// `zsh`, `bash`, `fish` — never anything that could carry a metacharacter into
/// the remote command line. Mirrors SHELL_NAME_RE in remote-cli-shells.ts.
fn is_shell_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// Wrap `body` as one single-quoted POSIX shell word.
///
/// Every body this module runs is a hardcoded constant, so this is belt and
/// braces rather than a live injection defence — but the wrapping itself is
/// load-bearing: `ssh host "zsh -lic curl -fsSL … | bash"` would pipe the SSH
/// invocation, not the remote command.
fn sq(body: &str) -> String {
    format!("'{}'", body.replace('\'', r"'\''"))
}

fn target_from(
    backend: &str,
    distro: Option<String>,
    host: Option<String>,
    username: Option<String>,
    identity_file: Option<String>,
    shell: Option<String>,
) -> Result<Target, String> {
    match backend {
        "wsl" => Ok(Target::Wsl { distro }),
        "windows" => Ok(Target::Windows),
        "native" => Ok(Target::Native),
        "ssh" => {
            let host = host.filter(|s| !s.trim().is_empty()).ok_or("SSH host missing")?;
            let username = username
                .filter(|s| !s.trim().is_empty())
                .ok_or("SSH username missing")?;
            // BatchMode means there is nobody to type a password to, so key auth
            // is not a preference here — it is the only thing that can work.
            let identity_file = identity_file
                .filter(|s| !s.trim().is_empty())
                .ok_or("SSH-key auth required (no identity file)")?;
            let shell = shell.filter(|s| is_shell_name(s)).unwrap_or_else(|| "bash".into());
            Ok(Target::Ssh { host, username, identity_file, shell })
        }
        other => Err(format!("unknown backend: {other}")),
    }
}

/// Build the command that runs `body` on `target`.
fn command_for(target: &Target, body: &str) -> Result<Command, String> {
    Ok(match target {
        Target::Wsl { distro } => {
            let mut c = crate::wsl_command_in(distro.as_deref());
            c.args(["--", "bash", "-lic", body]);
            c
        }
        Target::Native => {
            let mut c = Command::new("bash");
            c.args(["-lic", body]);
            c
        }
        Target::Windows => {
            // The Claude installer is PowerShell; everything else is npm, which
            // only resolves as npm.cmd through a shell.
            if body.starts_with("irm ") {
                let mut c = crate::hidden_command("powershell.exe");
                c.args(["-NoProfile", "-NonInteractive", "-Command", body]);
                c
            } else {
                let mut c = crate::hidden_command("cmd.exe");
                c.args(["/C", body]);
                c
            }
        }
        Target::Ssh { host, username, identity_file, shell } => {
            let key = crate::expand_home(identity_file)?;
            let remote = format!("{} -lic {}", shell, sq(body));
            let mut c = crate::ssh_background_command();
            c.args([
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                "ConnectTimeout=10",
                "-i",
                &key,
                &format!("{username}@{host}"),
                &remote,
            ]);
            c
        }
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Probe
// ─────────────────────────────────────────────────────────────────────────────

/// Resolve `cli` on `backend` right now. Returns its absolute path, or an empty
/// string when the backend answered and the CLI genuinely is not there.
///
/// An `Err` means the question could not be asked (WSL wedged, host
/// unreachable) — the frontend maps that to "unknown" and shows nothing, never
/// to "not installed". Telling someone to install what they already have is
/// worse than staying silent.
#[tauri::command]
pub async fn cli_probe(
    cli: String,
    backend: String,
    distro: Option<String>,
    host: Option<String>,
    username: Option<String>,
    identity_file: Option<String>,
    shell: Option<String>,
) -> Result<String, String> {
    let cli = AiCli::parse(&cli)?;
    let target = target_from(&backend, distro, host, username, identity_file, shell)?;
    let bin = cli.binary();

    let windows = matches!(target, Target::Windows);
    let mut cmd = match &target {
        // `where.exe` is what windows_resolve_cli_env already uses.
        Target::Windows => {
            let mut c = crate::hidden_command("where.exe");
            c.arg(bin);
            c
        }
        // `|| true` keeps the exit status clean so a plain "not found" is not
        // reported as a failed probe.
        t => command_for(t, &format!("command -v {bin} 2>/dev/null || true"))?,
    };

    let (code, text) =
        run_to_completion(&mut cmd, PROBE_DEADLINE).map_err(|e| format!("probe failed: {e}"))?;
    // where.exe exits 1 when it finds nothing; the Unix form always exits 0, so
    // there a non-zero status means the probe itself broke.
    if code != 0 && !windows {
        return Err(format!("probe exited {code}"));
    }
    Ok(text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string())
}

/// Run `cmd` to completion with a deadline, capturing stdout+stderr together.
fn run_to_completion(cmd: &mut Command, deadline: Duration) -> Result<(i32, String), String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stdout = child.stdout.take();
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                let mut text = String::new();
                if let Some(ref mut o) = stdout {
                    let _ = o.read_to_string(&mut text);
                }
                return Ok((status.code().unwrap_or(-1), text));
            }
            None => {
                if started.elapsed() > deadline {
                    let _ = child.kill();
                    return Err("timed out".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming install
// ─────────────────────────────────────────────────────────────────────────────

struct InstallState {
    /// The step currently running. Replaced when the ladder moves to its
    /// fallback, so Cancel always kills what is actually live.
    child: Option<Child>,
    cancelled: bool,
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn installs() -> &'static Mutex<HashMap<u32, InstallState>> {
    static INSTALLS: OnceLock<Mutex<HashMap<u32, InstallState>>> = OnceLock::new();
    INSTALLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cancelled(id: u32) -> bool {
    installs().lock().unwrap().get(&id).map(|s| s.cancelled).unwrap_or(true)
}

/// Start installing `cli` on `backend`. Returns an install id immediately;
/// output arrives on `on_line` and the final exit code on `on_exit` (0 = the
/// CLI is installed, `EXIT_CANCELLED` = the user stopped it, anything else =
/// the last rung of the ladder failed and its stderr is in the log).
#[tauri::command]
pub async fn cli_install_start(
    cli: String,
    backend: String,
    distro: Option<String>,
    host: Option<String>,
    username: Option<String>,
    identity_file: Option<String>,
    shell: Option<String>,
    on_line: Channel<String>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let cli = AiCli::parse(&cli)?;
    let target = target_from(&backend, distro, host, username, identity_file, shell)?;
    let ladder = match target {
        Target::Windows => windows_ladder(cli),
        _ => unix_ladder(cli),
    };
    // Fail before the modal starts spinning if the target itself is malformed
    // (bad SSH key path), rather than one line into the log.
    for body in &ladder {
        command_for(&target, body)?;
    }

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    installs()
        .lock()
        .unwrap()
        .insert(id, InstallState { child: None, cancelled: false });

    std::thread::spawn(move || {
        let code = run_ladder(id, &target, &ladder, &on_line);
        installs().lock().unwrap().remove(&id);
        let _ = on_exit.send(code);
    });

    Ok(id)
}

/// Walk the install ladder, streaming as it goes. Returns the exit code of the
/// step that succeeded, or of the last one that failed.
fn run_ladder(id: u32, target: &Target, ladder: &[String], on_line: &Channel<String>) -> i32 {
    let mut last = EXIT_NOT_SPAWNED;

    for (i, body) in ladder.iter().enumerate() {
        if cancelled(id) {
            let _ = on_line.send("— cancelled —".to_string());
            return EXIT_CANCELLED;
        }
        if i > 0 {
            // Say WHY the second rung is running. Without this line a Claude
            // install that quietly switched to npm looks like it ran the wrong
            // command all along.
            let _ = on_line.send(format!(
                "— previous step failed (exit {last}), falling back to npm —"
            ));
        }
        let _ = on_line.send(format!("$ {body}"));

        let mut cmd = match command_for(target, body) {
            Ok(c) => c,
            Err(e) => {
                let _ = on_line.send(format!("could not build command: {e}"));
                last = EXIT_NOT_SPAWNED;
                continue;
            }
        };
        last = run_step(id, &mut cmd, on_line);
        if last == 0 || last == EXIT_CANCELLED {
            return last;
        }
    }
    last
}

/// Run one step, pumping both pipes into `on_line` until the child exits.
fn run_step(id: u32, cmd: &mut Command, on_line: &Channel<String>) -> i32 {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = on_line.send(format!("could not start: {e}"));
            return EXIT_NOT_SPAWNED;
        }
    };

    // Both pipes, not just stdout: npm writes its entire progress to stderr, so
    // a stdout-only pump shows an empty log for the whole install.
    let pumps: Vec<_> = [
        child.stdout.take().map(PipeSource::Out),
        child.stderr.take().map(PipeSource::Err),
    ]
    .into_iter()
    .flatten()
    .map(|src| {
        let ch = on_line.clone();
        std::thread::spawn(move || pump(src, &ch))
    })
    .collect();

    {
        let mut guard = installs().lock().unwrap();
        match guard.get_mut(&id) {
            Some(state) => state.child = Some(child),
            // Cancelled between the ladder check and here.
            None => {
                let _ = child.kill();
                return EXIT_CANCELLED;
            }
        }
    }

    // Poll rather than `child.wait()`: the child lives in the registry so Cancel
    // can reach it, and holding it borrowed for the whole wait would deadlock
    // that. Every branch computes its verdict under the lock and reports it
    // after, so no message is ever emitted while the registry is held.
    let started = Instant::now();
    let code = loop {
        let tick = {
            let mut guard = installs().lock().unwrap();
            match guard.get_mut(&id).and_then(|s| {
                let cancelled = s.cancelled;
                s.child.as_mut().map(|c| (cancelled, c))
            }) {
                None => Tick::Gone,
                Some((true, child)) => {
                    let _ = child.kill();
                    Tick::Cancelled
                }
                Some((false, child)) => match child.try_wait() {
                    Ok(Some(status)) => Tick::Exited(status.code().unwrap_or(-1)),
                    Ok(None) if started.elapsed() > STEP_DEADLINE => {
                        let _ = child.kill();
                        Tick::TimedOut
                    }
                    Ok(None) => Tick::Wait,
                    Err(e) => Tick::Failed(e.to_string()),
                },
            }
        };
        match tick {
            Tick::Exited(code) => break code,
            Tick::Gone => break EXIT_CANCELLED,
            Tick::Cancelled => {
                let _ = on_line.send("— cancelled —".to_string());
                break EXIT_CANCELLED;
            }
            Tick::TimedOut => {
                let _ = on_line.send(format!(
                    "— gave up after {} minutes —",
                    STEP_DEADLINE.as_secs() / 60
                ));
                break -1;
            }
            Tick::Failed(e) => {
                let _ = on_line.send(format!("wait failed: {e}"));
                break -1;
            }
            Tick::Wait => std::thread::sleep(Duration::from_millis(120)),
        }
    };

    // The pumps end when the pipes close, which the kill above guarantees.
    for p in pumps {
        let _ = p.join();
    }
    if let Some(state) = installs().lock().unwrap().get_mut(&id) {
        state.child = None;
    }
    code
}

enum PipeSource {
    Out(std::process::ChildStdout),
    Err(std::process::ChildStderr),
}

/// One poll of the running step, decided under the registry lock and acted on
/// after it is released.
enum Tick {
    Exited(i32),
    Cancelled,
    TimedOut,
    Failed(String),
    /// The install was removed from the registry underneath us.
    Gone,
    Wait,
}

/// Forward one pipe line-by-line. Lines longer than the buffer or invalid UTF-8
/// are lossily converted rather than dropped — installer output is for humans.
fn pump(src: PipeSource, on_line: &Channel<String>) {
    let reader: Box<dyn Read + Send> = match src {
        PipeSource::Out(o) => Box::new(o),
        PipeSource::Err(e) => Box::new(e),
    };
    let mut buf = Vec::new();
    let mut reader = BufReader::new(reader);
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim_end_matches(['\r', '\n']).to_string();
                if on_line.send(line).is_err() {
                    break;
                }
            }
        }
    }
}

/// Stop an install. Kills the live child and stops the ladder from advancing to
/// its fallback. Unknown ids are a no-op — the install may have just finished.
#[tauri::command]
pub async fn cli_install_cancel(id: u32) -> Result<(), String> {
    let mut guard = installs().lock().unwrap();
    if let Some(state) = guard.get_mut(&id) {
        state.cancelled = true;
        if let Some(child) = state.child.as_mut() {
            let _ = child.kill();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_has_an_npm_fallback_and_the_others_do_not() {
        assert_eq!(unix_ladder(AiCli::Claude).len(), 2);
        assert!(unix_ladder(AiCli::Claude)[0].contains("claude.ai/install.sh"));
        assert!(unix_ladder(AiCli::Claude)[1].contains("@anthropic-ai/claude-code"));
        assert_eq!(unix_ladder(AiCli::Codex), vec!["npm install -g @openai/codex"]);
        assert_eq!(unix_ladder(AiCli::Gemini), vec!["npm install -g @google/gemini-cli"]);
    }

    #[test]
    fn windows_claude_uses_the_powershell_installer() {
        assert!(windows_ladder(AiCli::Claude)[0].starts_with("irm "));
        assert!(windows_ladder(AiCli::Claude)[1].starts_with("npm install -g"));
    }

    #[test]
    fn only_plain_shell_names_are_accepted() {
        assert!(is_shell_name("zsh"));
        assert!(is_shell_name("bash"));
        assert!(!is_shell_name("bash; rm -rf ~"));
        assert!(!is_shell_name("$(id)"));
        assert!(!is_shell_name(""));
    }

    #[test]
    fn ssh_bodies_are_one_quoted_word() {
        assert_eq!(sq("curl -fsSL x | bash"), "'curl -fsSL x | bash'");
        assert_eq!(sq("it's"), r"'it'\''s'");
    }

    #[test]
    fn ssh_requires_a_key() {
        let err = target_from("ssh", None, Some("h".into()), Some("u".into()), None, None)
            .err()
            .unwrap();
        assert!(err.contains("SSH-key"));
    }

    #[test]
    fn an_untrusted_shell_name_falls_back_to_bash() {
        let t = target_from(
            "ssh",
            None,
            Some("h".into()),
            Some("u".into()),
            Some("~/.ssh/id".into()),
            Some("zsh; id".into()),
        )
        .unwrap();
        match t {
            Target::Ssh { shell, .. } => assert_eq!(shell, "bash"),
            _ => panic!("expected ssh target"),
        }
    }
}

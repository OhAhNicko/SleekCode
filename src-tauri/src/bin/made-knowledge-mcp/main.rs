//! `made-knowledge-mcp` — the MCP stdio server that lets Claude Code, Codex and
//! Gemini read and write MADE's shared project memory.
//!
//! Each CLI launches this binary itself, from a registration MADE wrote once
//! (`claude mcp add --scope user made-knowledge -- <path> --agent claude`). It
//! speaks MCP over stdin/stdout and forwards everything to the running MADE over
//! a loopback socket.
//!
//! **This process holds no durable state and writes no files.** Every answer
//! comes from the service; if MADE is not running there is nothing here to serve
//! from, and the tools say so rather than inventing an answer. That is also why
//! the CLIs can be registered once and keep working across MADE restarts — the
//! adapter re-discovers the endpoint on every reconnect.
//!
//! Identity the model cannot forge:
//!
//! - `--agent <cli>` is baked into each CLI's own registration, so it describes
//!   who LAUNCHED this process, not who is asking.
//! - The project comes from this process's working directory, which the CLI set
//!   and the service re-validates against the projects it actually has open.
//! - `MADE_PANE_ID` is inherited from the pane MADE spawned the CLI in. On the
//!   WSL→Windows path it crosses the boundary via `WSLENV=MADE_PANE_ID/w`.
//!
//! Diagnostics go to STDERR only — stdout is the MCP transport, and a stray
//! `println!` there corrupts the protocol. The token, note content and prompt
//! text never appear in either.

mod endpoint;
mod identity;
mod server;
mod service_client;
mod wire;

use std::path::PathBuf;
use std::sync::Arc;

use rmcp::ServiceExt;

use service_client::{AdapterIdentity, ServiceClient};

struct Args {
    agent: String,
    endpoint: Option<PathBuf>,
}

/// Parse `--agent <cli>` and `--endpoint <path>`.
///
/// An unknown or missing `--agent` is NOT fatal: the server still runs, with
/// `agentKind = unknown`. A registration written by an older MADE, or by hand,
/// should degrade to unattributed memory rather than to a CLI that reports its
/// knowledge server as broken.
fn parse_args() -> Args {
    let mut agent = identity::AGENT_UNKNOWN.to_string();
    let mut endpoint = None;
    let mut argv = std::env::args().skip(1);
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--agent" => {
                if let Some(value) = argv.next() {
                    let normalized = identity::normalize_agent(&value);
                    if normalized == identity::AGENT_UNKNOWN && !value.trim().is_empty() {
                        eprintln!(
                            "[made-knowledge-mcp] '{value}' is not a known CLI — serving as \
                             'unknown'; writes will be attributed to no agent."
                        );
                    }
                    agent = normalized;
                }
            }
            "--endpoint" => endpoint = argv.next().map(PathBuf::from),
            "--help" | "-h" => {
                eprintln!(
                    "made-knowledge-mcp {}\n\nAn MCP stdio server for MADE's shared project \
                     memory. Launched by a CLI, not by hand.\n\n  --agent <claude|codex|gemini>  \
                     which CLI launched this adapter\n  --endpoint <path>              an \
                     explicit MADE endpoint file (testing)\n",
                    env!("CARGO_PKG_VERSION")
                );
                std::process::exit(0);
            }
            other => eprintln!("[made-knowledge-mcp] ignoring unknown argument '{other}'"),
        }
    }
    Args { agent, endpoint }
}

fn main() {
    let args = parse_args();

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let project_root_guess = identity::find_project_root(&cwd);
    let pane_id = std::env::var(identity::PANE_ENV)
        .ok()
        .as_deref()
        .and_then(identity::sanitize_pane_id);

    eprintln!(
        "[made-knowledge-mcp] {} agent={} cwd={} project={} pane={}",
        env!("CARGO_PKG_VERSION"),
        args.agent,
        cwd.display(),
        project_root_guess
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "(none found)".into()),
        pane_id.as_deref().unwrap_or("(none)"),
    );

    // A single-threaded runtime: this process relays frames between one stdin
    // pipe and one socket. Extra workers would buy nothing and cost a thread
    // per CLI pane, and there can be a lot of panes.
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[made-knowledge-mcp] could not start a runtime: {e}");
            std::process::exit(1);
        }
    };

    let client = Arc::new(ServiceClient::new(AdapterIdentity {
        agent: args.agent.clone(),
        cwd: cwd.to_string_lossy().to_string(),
        project_root_guess: project_root_guess.map(|p| p.to_string_lossy().to_string()),
        pane_id,
        endpoint_override: args.endpoint,
    }));

    let code = runtime.block_on(async move {
        let handler = server::KnowledgeServer::new(client, args.agent);
        let service = match handler.serve(rmcp::transport::stdio()).await {
            Ok(service) => service,
            Err(e) => {
                // The transport itself failed to come up — nothing was served,
                // so this IS a failure exit.
                eprintln!("[made-knowledge-mcp] could not start the MCP server: {e}");
                return 1;
            }
        };
        // Runs until the client closes stdin. That is the normal end of life
        // for a stdio MCP server — the CLI exits, the pipe closes, and this
        // process follows it out cleanly.
        match service.waiting().await {
            Ok(reason) => {
                eprintln!("[made-knowledge-mcp] shutting down: {reason:?}");
                0
            }
            Err(e) => {
                eprintln!("[made-knowledge-mcp] server task ended abnormally: {e}");
                1
            }
        }
    });

    std::process::exit(code);
}

//! The MCP surface: 15 tools, 8 fixed resources plus per-note reads, and 4
//! prompts — all of them thin translations onto the NDJSON methods in
//! `knowledge/ipc.rs`.
//!
//! Three rules shape everything below.
//!
//! **`initialize` always succeeds.** The tool, resource and prompt LISTS are
//! static, so a CLI can start, connect and show `made-knowledge` as available
//! even with MADE closed. Only an actual call reaches the service, and only
//! then does "MADE is not running" appear — as an answer, in-band, where the
//! model can act on it.
//!
//! **A refusal is not an exception.** A stale `baseRevision`, a denied write
//! and a read-only project are all normal outcomes of a correct call, so they
//! come back as `isError: false` results carrying the data needed to retry.
//! `isError: true` is reserved for "this did not happen and cannot right now".
//!
//! **Tool names use underscores.** Codex and Gemini both reject dots in tool
//! names, so `knowledge_search` rather than the spec's dotted spelling — a
//! documented deviation, because a name two of the three CLIs refuse to load is
//! not a name.

use std::borrow::Cow;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rmcp::model::*;
use rmcp::service::{MaybeSendFuture, NotificationContext, RequestContext, RoleServer};
use rmcp::{ErrorData as McpError, ServerHandler};
use serde_json::{json, Map, Value};

use crate::identity;
use crate::service_client::{ServiceClient, ServiceError, APPROVAL_TIMEOUT, READ_TIMEOUT};
use crate::wire;

/// The name this adapter reports in its MCP handshake — per build, matching
/// the registration name `mcp_config::SERVER_NAME` writes.
#[cfg(debug_assertions)]
const SERVER_NAME: &str = "made-nexus-dev";
#[cfg(not(debug_assertions))]
const SERVER_NAME: &str = "made-nexus";

/// What a caller sees when MADE is not running. Names the fallback that always
/// works — the markdown projection is on disk whether MADE is up or not. A
/// function, not a const, because the folder's spelling is per-build
/// (`identity::MEMORY_DIR`).
fn service_down() -> String {
    format!(
        "MADE is not running — shared knowledge is unavailable. \
         Start MADE, or read the project's {}/ markdown directly.",
        identity::MEMORY_DIR
    )
}

const INSTRUCTIONS: &str = "Shared project memory for this workspace, kept by MADE and visible to \
     Claude Code, Codex and Gemini alike. Read it before asking the user to re-explain the \
     project: knowledge_get_context and the knowledge://project/* resources carry the current \
     state, architecture, decisions, learnings and open tasks. Write back what a later session \
     would need — decisions, learnings, state changes, handoffs. Updates are revisioned: pass the \
     baseRevision you read, and if the answer says the note moved on, re-read it, merge, and \
     retry.";

const URI_PREFIX: &str = "knowledge://";
const URI_NOTES: &str = "knowledge://notes/";
const URI_CHANGES: &str = "knowledge://changes/recent";

/// How many notes `resources/list` will enumerate. A vault larger than this is
/// browsed through `knowledge_search`, not by listing everything into a context
/// window.
const NOTE_LIST_CAP: usize = 100;

// ---------------------------------------------------------------------------
// Tool catalogue
// ---------------------------------------------------------------------------

struct ToolDef {
    name: &'static str,
    /// The `ipc::dispatch` method this maps onto.
    method: &'static str,
    description: &'static str,
    schema: fn() -> Value,
}

/// The 6 read tools and 9 write tools, in the order they are listed.
///
/// Every schema is closed (`additionalProperties: false`) and none of them
/// declares an identity field: `agentKind`, `paneId`, `sessionId` and the
/// project are constructed from the connection, so a schema that accepted them
/// would be advertising a lie.
const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "knowledge_search",
        method: wire::M_SEARCH,
        description: "Full-text search across this project's shared memory. Returns matching \
             notes with a highlighted snippet, their type and who last changed them.",
        schema: || {
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "query": { "type": "string", "description": "Words or a phrase to look for." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 }
                },
                "required": ["query"]
            })
        },
    },
    ToolDef {
        name: "knowledge_get_context",
        method: wire::M_GET_CONTEXT,
        description: "Assemble a token-budgeted context package from named references. Use \
             this first on a new task: pass refs like \"state\", \"architecture\", \"decisions\", \
             \"tasks\" or a note id to get their current content in one call.",
        schema: || {
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "refs": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Core document names (project, state, architecture, \
                             decisions, learnings, tasks, handoffs) or note ids."
                    },
                    "budgetTokens": { "type": "integer", "minimum": 500, "default": 12000 }
                },
                "required": ["refs"]
            })
        },
    },
    ToolDef {
        name: "knowledge_get_note",
        method: wire::M_GET_NOTE,
        description: "Read one note in full, with the revision number to pass as baseRevision \
             when updating it. Give either an id, or a core document type (project, state, \
             architecture, decisions, learnings, tasks, handoffs).",
        schema: || {
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "id": { "type": "string", "description": "A note id, e.g. kn_1a2b…" },
                    "type": {
                        "type": "string",
                        "enum": ["project", "state", "architecture", "decisions", "learnings",
                                 "tasks", "handoffs"],
                        "description": "Read a core document instead of a note id."
                    }
                }
            })
        },
    },
    ToolDef {
        name: "knowledge_list_recent_changes",
        method: wire::M_LIST_RECENT_CHANGES,
        description: "What changed in this project's memory lately, and who changed it — \
             including edits made by the user or by another CLI since this session started.",
        schema: || {
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "sinceSeq": {
                        "type": "integer",
                        "description": "Only events after this sequence number. Omit for the \
                             most recent ones."
                    },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
                }
            })
        },
    },
    ToolDef {
        name: "knowledge_get_latest_handoff",
        method: wire::M_GET_LATEST_HANDOFF,
        description: "The most recent handoff another agent or session left behind: what was \
             done, what is in flight, what remains, and the suggested next action.",
        schema: || json!({ "type": "object", "additionalProperties": false, "properties": {} }),
    },
    ToolDef {
        name: "knowledge_list_tasks",
        method: wire::M_LIST_TASKS,
        description: "The project's shared task list, as tracked in TASKS.md.",
        schema: || {
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "includeDone": { "type": "boolean", "default": false }
                }
            })
        },
    },
    ToolDef {
        name: "knowledge_create_note",
        method: wire::M_CREATE_NOTE,
        description: "Create a new note in the project's shared memory. Prefer appending to a \
             core document (knowledge_add_decision / knowledge_add_learning) when the content \
             belongs there; notes are for standalone material.",
        schema: || {
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "title": { "type": "string" },
                    "content": { "type": "string", "description": "Markdown body. Start it with \
                         a `# Title` heading." },
                    "noteType": { "type": "string", "default": "note" },
                    "tags": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["title", "content"]
            })
        },
    },
    ToolDef {
        name: "knowledge_update_note",
        method: wire::M_UPDATE_NOTE,
        description: "Replace a note's content. Pass the baseRevision you read; if the note has \
             moved on since, the answer carries the current revision and content so you can \
             merge and retry rather than overwriting someone else's work.",
        schema: || {
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "id": { "type": "string" },
                    "baseRevision": {
                        "type": "integer",
                        "description": "The revision you read before editing."
                    },
                    "content": { "type": "string" },
                    "title": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "reason": { "type": "string", "description": "One line for the history." }
                },
                "required": ["id", "baseRevision", "content"]
            })
        },
    },
    ToolDef {
        name: "knowledge_update_state",
        method: wire::M_UPDATE_STATE,
        description: "Replace STATE.md — where the project currently stands. Read it first \
             (knowledge_get_note with type \"state\", or the knowledge://project/state resource) \
             and pass the revision you read as baseRevision.",
        schema: || {
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The FULL new document. This replaces STATE.md, it does \
                             not append to it."
                    },
                    "baseRevision": {
                        "type": "integer",
                        "description": "The revision you read. Required: it is what detects that \
                             someone else changed the document while you were working."
                    },
                    "reason": { "type": "string" }
                },
                "required": ["content", "baseRevision"]
            })
        },
    },
    ToolDef {
        name: "knowledge_add_decision",
        method: wire::M_ADD_DECISION,
        description: "Record a decision and why it was made. Appended to DECISIONS.md, so it \
             never conflicts with a concurrent write.",
        schema: || append_entry_schema(),
    },
    ToolDef {
        name: "knowledge_add_learning",
        method: wire::M_ADD_LEARNING,
        description: "Record something learned the hard way — a gotcha, a root cause, a dead \
             end worth not repeating. Appended to LEARNINGS.md.",
        schema: || append_entry_schema(),
    },
    ToolDef {
        name: "knowledge_create_handoff",
        method: wire::M_CREATE_HANDOFF,
        description: "Leave a structured handoff for whoever picks this up next — another CLI, \
             another session, or the user tomorrow.",
        schema: || {
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "task": { "type": "string", "description": "One line: what this work is." },
                    "completed": { "type": "array", "items": { "type": "string" } },
                    "currentWork": { "type": "string" },
                    "remaining": { "type": "array", "items": { "type": "string" } },
                    "filesChanged": { "type": "array", "items": { "type": "string" } },
                    "decisions": { "type": "array", "items": { "type": "string" } },
                    "knownIssues": { "type": "array", "items": { "type": "string" } },
                    "nextAction": { "type": "string" }
                },
                "required": ["task"]
            })
        },
    },
    ToolDef {
        name: "knowledge_create_task",
        method: wire::M_CREATE_TASK,
        description: "Add a task to the project's shared task list.",
        schema: || {
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "title": { "type": "string" },
                    "detail": { "type": "string" }
                },
                "required": ["title"]
            })
        },
    },
    ToolDef {
        name: "knowledge_update_task",
        method: wire::M_UPDATE_TASK,
        description: "Change a task's status, title, detail or assignee.",
        schema: || {
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "id": { "type": "string" },
                    "status": {
                        "type": "string",
                        "enum": ["open", "in-progress", "done", "archived"]
                    },
                    "title": { "type": "string" },
                    "detail": { "type": "string" },
                    "assignee": { "type": "string" }
                },
                "required": ["id"]
            })
        },
    },
    ToolDef {
        name: "knowledge_link_entities",
        method: wire::M_LINK_ENTITIES,
        description: "Record an explicit relationship between two notes, so a later reader \
             finds one from the other.",
        schema: || {
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "sourceId": { "type": "string" },
                    "targetId": { "type": "string" },
                    "relType": { "type": "string", "default": "relates-to" }
                },
                "required": ["sourceId", "targetId"]
            })
        },
    },
];

fn append_entry_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "title": { "type": "string", "description": "The heading for this entry." },
            "content": { "type": "string", "description": "Markdown body of the entry." },
            "tags": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["title", "content"]
    })
}

fn find_tool(name: &str) -> Option<&'static ToolDef> {
    TOOLS.iter().find(|t| t.name == name)
}

/// Fields a tool's own schema marks required that the call did not supply.
///
/// The schema is enforced HERE, not merely advertised, because a model omitting
/// an "optional" `baseRevision` is not a rare event — it is the common case,
/// and it is exactly how a revisioned store degrades into silent
/// last-writer-wins. The service refuses these too; catching them a step
/// earlier means a malformed write never reaches it, and the model gets a
/// message that names the field instead of a generic rejection.
///
/// Absent or explicitly `null` only, matching what the service treats as
/// missing — an empty string is a value someone may genuinely have meant.
fn missing_required(schema: &Value, args: &Map<String, Value>) -> Vec<String> {
    schema
        .get("required")
        .and_then(Value::as_array)
        .map(|required| {
            required
                .iter()
                .filter_map(Value::as_str)
                .filter(|key| !args.get(*key).is_some_and(|v| !v.is_null()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn to_object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Fixed resources
// ---------------------------------------------------------------------------

/// `(uri, core document type, human title)`. The seven core documents plus the
/// handoff shortcut; `knowledge://changes/recent` is added separately because
/// it is not a document.
const CORE_RESOURCES: &[(&str, &str, &str)] = &[
    ("knowledge://project/summary", "project", "Project summary"),
    ("knowledge://project/state", "state", "Current state"),
    ("knowledge://project/architecture", "architecture", "Architecture"),
    ("knowledge://project/decisions", "decisions", "Decisions"),
    ("knowledge://project/learnings", "learnings", "Learnings"),
    ("knowledge://project/tasks", "tasks", "Tasks"),
    ("knowledge://project/handoffs/latest", "handoffs", "Latest handoff"),
];

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const PROMPTS: &[(&str, &str)] = &[
    (
        "continue-from-latest-handoff",
        "Pick up where the last agent or session left off, from the most recent handoff.",
    ),
    (
        "prepare-agent-handoff",
        "Summarise this session's work into a handoff for the next agent.",
    ),
    (
        "review-recent-knowledge-changes",
        "Review what changed in the project's shared memory recently.",
    ),
    (
        "update-project-memory",
        "Bring STATE.md and the task list up to date with what actually happened.",
    ),
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

pub struct KnowledgeServer {
    client: Arc<ServiceClient>,
    agent: String,
}

impl KnowledgeServer {
    pub fn new(client: Arc<ServiceClient>, agent: String) -> Self {
        Self { client, agent }
    }

    /// How long to wait on a call.
    ///
    /// EVERY write gets the long window, with no fast path for a trusted
    /// project. The adapter must always outlast the service's 90s approval hold,
    /// because whoever gives up first decides what the user sees: if the service
    /// answers, a denial is structured and a commit is reported; if the adapter
    /// gives up, the write can still commit afterwards while the model has
    /// already been told it failed.
    ///
    /// This used to consult the handshake's `writePolicy` and use a 30s bound
    /// for `trusted`. The handshake reports that policy ONCE and the service
    /// re-reads it per request, so a project tightened to `ask` after the
    /// connection opened kept the short bound — and produced exactly the split
    /// outcome above, plus a duplicate entry when the model retried onto a
    /// connection the service had since granted. The saving was never worth a
    /// second source of truth for a value the user can change at any moment.
    fn budget(&self, method: &str) -> Duration {
        if wire::is_write_method(method) {
            APPROVAL_TIMEOUT
        } else {
            READ_TIMEOUT
        }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, ServiceError> {
        let started = Instant::now();
        let ids = notable_ids(&params);
        let budget = self.budget(method);
        let result = self.client.call(method, params, budget).await;
        audit(
            &self.agent,
            method,
            &ids,
            match &result {
                Ok(_) => "ok",
                Err(e) => e.kind(),
            },
            started.elapsed(),
        );
        result
    }

    /// Fetch markdown for a resource URI. `Ok(None)` means "no such resource",
    /// which the caller turns into a protocol-level not-found.
    async fn resource_markdown(&self, uri: &str) -> Result<Option<String>, ServiceError> {
        if let Some(id) = uri.strip_prefix(URI_NOTES) {
            if id.is_empty() {
                return Ok(None);
            }
            let note = self.call(wire::M_GET_NOTE, json!({ "id": id })).await?;
            return Ok(Some(render_note(&note)));
        }
        if uri == URI_CHANGES {
            let changes = self
                .call(wire::M_LIST_RECENT_CHANGES, json!({ "limit": 50 }))
                .await?;
            return Ok(Some(render_changes(&changes)));
        }
        let Some((_, kind, title)) = CORE_RESOURCES.iter().find(|(u, _, _)| *u == uri) else {
            return Ok(None);
        };
        // The handoff shortcut answers with the rendered handoff when there is
        // one, and falls through to HANDOFFS.md when there is not — an empty
        // document is a truer answer than an error.
        if uri.ends_with("/handoffs/latest") {
            let latest = self.call(wire::M_GET_LATEST_HANDOFF, json!({})).await?;
            if let Some(md) = latest
                .get("renderedMarkdown")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            {
                return Ok(Some(format!("# {title}\n\n{md}")));
            }
        }
        let doc = self.call(wire::M_GET_DOC, json!({ "kind": kind })).await?;
        Ok(Some(render_note(&doc)))
    }
}

impl ServerHandler for KnowledgeServer {
    fn get_info(&self) -> ServerInfo {
        // Tools, resources and prompts — deliberately NO subscriptions and no
        // listChanged: the adapter holds no state to notify about, and the
        // service's change events reach the user through MADE's own UI.
        let capabilities = ServerCapabilities::builder()
            .enable_tools()
            .enable_resources()
            .enable_prompts()
            .build();
        let mut info = ServerInfo::new(capabilities);
        info.server_info = Implementation::new(SERVER_NAME, env!("CARGO_PKG_VERSION"));
        info.instructions = Some(INSTRUCTIONS.to_string());
        info
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, McpError>> + MaybeSendFuture + '_
    {
        // Static, so a CLI showing "15 tools" is telling the truth whether or
        // not MADE is running.
        let tools = TOOLS
            .iter()
            .map(|def| {
                Tool::new(
                    def.name,
                    Cow::Borrowed(def.description),
                    Arc::new(to_object((def.schema)())),
                )
            })
            .collect();
        std::future::ready(Ok(ListToolsResult::with_all_items(tools)))
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CallToolResponse, McpError>> + MaybeSendFuture + '_
    {
        async move {
            let Some(def) = find_tool(&request.name) else {
                // Unroutable, so a protocol error rather than a result: there
                // is no tool whose failure this could be.
                return Err(McpError::new(
                    ErrorCode::METHOD_NOT_FOUND,
                    format!("unknown tool '{}'", request.name),
                    None,
                ));
            };

            let mut args = request.arguments.unwrap_or_default();

            // Before anything else touches the arguments: a write missing the
            // field that makes it safe must not travel. Checked against the
            // tool's OWN schema, so the advertised contract and the enforced
            // one cannot drift apart.
            let missing = missing_required(&(def.schema)(), &args);
            if !missing.is_empty() {
                audit(&self.agent, def.method, "", "invalid-params", Duration::ZERO);
                return Ok(CallToolResponse::from(incomplete_call(
                    def.name,
                    &format!(
                        "{} was called without {}",
                        def.name,
                        english_list(&missing)
                    ),
                    missing.iter().any(|f| f == "baseRevision"),
                )));
            }

            let forged = identity::strip_forged_identity(&mut args);
            if !forged.is_empty() {
                // Worth a line: the service ignores these anyway, but an
                // attempt to set them is the shape of a prompt-injection probe.
                eprintln!(
                    "[made-knowledge-mcp] {} tried to set identity fields on {}: {}",
                    self.agent,
                    def.name,
                    forged.join(", ")
                );
            }

            // The one tool that fans out: a core document has no id, so reading
            // one by type goes to a different service method.
            let mut method = def.method;
            if def.name == "knowledge_get_note" {
                let has_id = args.get("id").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
                match (has_id, args.get("type").and_then(Value::as_str)) {
                    (false, Some(kind)) => {
                        let kind = kind.to_string();
                        args.clear();
                        args.insert("kind".into(), Value::String(kind));
                        method = wire::M_GET_DOC;
                    }
                    (false, None) => {
                        return Err(McpError::invalid_params(
                            "knowledge_get_note needs either an id or a core document type",
                            None,
                        ))
                    }
                    _ => {}
                }
            }

            let result = match self.call(method, Value::Object(args)).await {
                // Null is a real answer with nothing in it — today only the
                // latest-handoff read produces one. Say what it means instead
                // of printing "null" (the wire client used to misfile this as
                // an "empty reply" error; see WireResponse::ok).
                Ok(Value::Null) if method == wire::M_GET_LATEST_HANDOFF => {
                    CallToolResult::success(vec![ContentBlock::text(
                        "No handoff has been recorded for this project yet — \
                         knowledge_create_handoff writes the first one.",
                    )])
                }
                Ok(value) => success(value),
                Err(e) => failure(def.name, e),
            };
            Ok(CallToolResponse::from(result))
        }
    }

    fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListResourcesResult, McpError>> + MaybeSendFuture + '_
    {
        async move {
            let mut resources: Vec<Resource> = CORE_RESOURCES
                .iter()
                .map(|(uri, _, title)| {
                    Resource::new(*uri, *title)
                        .with_mime_type("text/markdown")
                        .with_description("Shared project memory, with revision metadata in its \
                             frontmatter.")
                })
                .collect();
            resources.push(
                Resource::new(URI_CHANGES, "Recent changes")
                    .with_mime_type("text/markdown")
                    .with_description("What changed in shared memory lately, and who changed it."),
            );

            // The notes are a bonus, never a requirement: listing resources
            // must not fail because MADE is closed, or the CLI shows the server
            // as broken rather than as idle.
            if let Ok(list) = self
                .call(wire::M_LIST_NOTE_SUMMARIES, json!({ "includeArchived": false }))
                .await
            {
                for meta in list.as_array().into_iter().flatten().take(NOTE_LIST_CAP) {
                    let (Some(id), Some(title)) = (
                        meta.get("id").and_then(Value::as_str),
                        meta.get("title").and_then(Value::as_str),
                    ) else {
                        continue;
                    };
                    resources.push(
                        Resource::new(format!("{URI_NOTES}{id}"), title)
                            .with_mime_type("text/markdown"),
                    );
                }
            }
            Ok(ListResourcesResult::with_all_items(resources))
        }
    }

    fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListResourceTemplatesResult, McpError>>
    + MaybeSendFuture
    + '_ {
        // So a note found through knowledge_search can be read as a resource
        // without waiting for it to appear in the capped listing.
        let template = ResourceTemplate::new(format!("{URI_NOTES}{{noteId}}"), "Note by id")
            .with_mime_type("text/markdown")
            .with_description("Any note in this project's shared memory, by its id.");
        std::future::ready(Ok(ListResourceTemplatesResult::with_all_items(vec![
            template,
        ])))
    }

    fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ReadResourceResponse, McpError>> + MaybeSendFuture + '_
    {
        async move {
            if !request.uri.starts_with(URI_PREFIX) {
                return Err(McpError::resource_not_found(
                    format!("{} is not a knowledge:// resource", request.uri),
                    None,
                ));
            }
            let text = match self.resource_markdown(&request.uri).await {
                Ok(Some(text)) => text,
                Ok(None) => {
                    return Err(McpError::resource_not_found(
                        format!("no resource at {}", request.uri),
                        None,
                    ))
                }
                // A read that could not reach the service is still a readable
                // answer — the model gets the reason and the fallback rather
                // than an opaque protocol error.
                Err(e) => format!("# Unavailable\n\n{}\n", explain(e)),
            };
            Ok(ReadResourceResponse::from(ReadResourceResult::new(vec![
                ResourceContents::text(text, &request.uri).with_mime_type("text/markdown"),
            ])))
        }
    }

    fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListPromptsResult, McpError>> + MaybeSendFuture + '_
    {
        let prompts = PROMPTS
            .iter()
            .map(|(name, description)| Prompt::new(*name, Some(*description), None))
            .collect();
        std::future::ready(Ok(ListPromptsResult::with_all_items(prompts)))
    }

    fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<GetPromptResponse, McpError>> + MaybeSendFuture + '_
    {
        async move {
            let Some((_, description)) = PROMPTS.iter().find(|(n, _)| *n == request.name) else {
                return Err(McpError::invalid_params(
                    format!("unknown prompt '{}'", request.name),
                    None,
                ));
            };
            let body = self.render_prompt(&request.name).await;
            let result = GetPromptResult::new(vec![PromptMessage::new_text(Role::User, body)])
                .with_description(*description);
            Ok(GetPromptResponse::from(result))
        }
    }

    fn on_initialized(
        &self,
        context: NotificationContext<RoleServer>,
    ) -> impl Future<Output = ()> + MaybeSendFuture + '_ {
        async move {
            // Forward the MCP client's self-description for the diagnostics
            // list. Deliberately WITHOUT a sessionId: a session id this process
            // could invent is a session id a model could invent, and MADE joins
            // the real one from its own pane registry.
            let Some(info) = context.peer.peer_info() else {
                return;
            };
            let _ = self
                .client
                .call(
                    wire::M_SESSION_INFO,
                    json!({
                        "clientName": info.client_info.name,
                        "clientVersion": info.client_info.version,
                    }),
                    READ_TIMEOUT,
                )
                .await;
        }
    }
}

impl KnowledgeServer {
    /// Prompts carry LIVE content, not just instructions: a handoff the model
    /// has to fetch itself is a handoff it will paraphrase from memory.
    async fn render_prompt(&self, name: &str) -> String {
        match name {
            "continue-from-latest-handoff" => {
                match self.call(wire::M_GET_LATEST_HANDOFF, json!({})).await {
                    Ok(Value::Null) => "There is no handoff recorded for this project yet. Call \
                         knowledge_get_context with [\"state\", \"tasks\"] to see where things \
                         stand."
                        .to_string(),
                    Ok(handoff) => format!(
                        "Continue this project from the handoff below. Read it, confirm the \
                         remaining work against knowledge_list_tasks, then start on the next \
                         action.\n\n{}",
                        handoff
                            .get("renderedMarkdown")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| pretty(&handoff))
                    ),
                    Err(e) => unavailable(e, "the latest handoff"),
                }
            }
            "prepare-agent-handoff" => {
                let changes = self
                    .call(wire::M_LIST_RECENT_CHANGES, json!({ "limit": 30 }))
                    .await;
                let tasks = self.call(wire::M_LIST_TASKS, json!({})).await;
                let mut body = String::from(
                    "Write a handoff for whoever picks this work up next, then record it with \
                     knowledge_create_handoff. Cover what is done, what is in flight, what \
                     remains, which files changed, and the single next action.\n",
                );
                if let Ok(changes) = changes {
                    body.push_str(&format!(
                        "\n## Recent memory changes\n\n{}\n",
                        render_changes(&changes)
                    ));
                }
                if let Ok(tasks) = tasks {
                    body.push_str(&format!("\n## Open tasks\n\n{}\n", pretty(&tasks)));
                }
                body
            }
            "review-recent-knowledge-changes" => {
                match self
                    .call(wire::M_LIST_RECENT_CHANGES, json!({ "limit": 50 }))
                    .await
                {
                    Ok(changes) => format!(
                        "Review what has changed in this project's shared memory. Flag anything \
                         that contradicts what you already believe about the project, and read \
                         the notes behind it before acting.\n\n{}",
                        render_changes(&changes)
                    ),
                    Err(e) => unavailable(e, "the recent change log"),
                }
            }
            "update-project-memory" => {
                let state = self.call(wire::M_GET_DOC, json!({ "kind": "state" })).await;
                let mut body = String::from(
                    "Bring the project's shared memory up to date with what actually happened in \
                     this session. Update STATE.md with knowledge_update_state (pass the \
                     baseRevision below), record any decisions with knowledge_add_decision, any \
                     gotchas with knowledge_add_learning, and close or add tasks with \
                     knowledge_update_task / knowledge_create_task.\n",
                );
                match state {
                    Ok(doc) => body.push_str(&format!(
                        "\n## STATE.md — revision {}\n\n{}\n",
                        doc.get("meta")
                            .and_then(|m| m.get("revision"))
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                        doc.get("content").and_then(Value::as_str).unwrap_or("")
                    )),
                    Err(e) => body.push_str(&format!("\n{}\n", unavailable(e, "STATE.md"))),
                }
                body
            }
            other => format!("Unknown prompt '{other}'."),
        }
    }
}

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

fn success(value: Value) -> CallToolResult {
    let mut result = CallToolResult::success(vec![ContentBlock::text(pretty(&value))]);
    // Structured too, so a client that can consume it does not have to re-parse
    // the text block. The MCP contract requires structuredContent to be an
    // OBJECT — Claude Code validates and rejects anything else, which is how a
    // bare-array reply (knowledge_list_tasks) failed schema validation in the
    // field (found by an agent, runtime step 9, 2026-08-08). Non-objects are
    // wrapped; the text block keeps the original shape.
    result.structured_content = Some(match value {
        Value::Object(_) => value,
        Value::Array(_) => json!({ "items": value }),
        other => json!({ "value": other }),
    });
    result
}

/// Turn a service error into what the caller should see.
///
/// The split is the whole point: a conflict, a denial and a read-only project
/// are `isError: false` — the call was correct and the answer is "not like
/// that, here is how". Only "this cannot happen right now" sets `isError`.
fn failure(tool: &str, err: ServiceError) -> CallToolResult {
    match err {
        ServiceError::Service(e) if e.code == wire::ERR_CONFLICT => {
            let mut result = CallToolResult::success(vec![ContentBlock::text(format!(
                "Not saved — this note changed since the revision you edited.\n\n{}\n\nRe-read \
                 the note, merge your change into the current content, and call {tool} again \
                 with the new baseRevision.",
                e.data.as_ref().map(pretty).unwrap_or_default()
            ))]);
            result.structured_content = e.data;
            result
        }
        ServiceError::Service(e) if e.code == wire::ERR_DENIED => CallToolResult::success(vec![
            ContentBlock::text(format!(
                "Not saved — {}\n\nAsk the user to approve knowledge writes in MADE (Settings > \
                 NexusMind > Memory write policy), then retry.",
                e.message
            )),
        ]),
        ServiceError::Service(e) if e.code == wire::ERR_READ_ONLY => CallToolResult::success(
            vec![ContentBlock::text(format!(
                "Not saved — {}\n\nReads still work; nothing was changed.",
                e.message
            ))],
        ),
        // The service refused the call as malformed. The adapter normally
        // catches these against the schema first, so reaching here means the
        // service enforces a rule the schema does not yet state — the model
        // still gets told which field, and to re-read for the revision.
        ServiceError::Service(e) if e.code == wire::ERR_INVALID_PARAMS => {
            let wants_revision = e.message.contains("baseRevision");
            incomplete_call(tool, &e.message, wants_revision)
        }
        ServiceError::Service(e) if e.code == wire::ERR_NOT_FOUND => {
            CallToolResult::error(vec![ContentBlock::text(format!(
                "{}\n\nUse knowledge_search or list the knowledge:// resources to find the right \
                 id.",
                e.message
            ))])
        }
        other => CallToolResult::error(vec![ContentBlock::text(explain(other))]),
    }
}

/// A write that was refused as incomplete.
///
/// `isError: true`, unlike conflict and denial. Those are correctly-formed
/// calls the world said no to, and the distinction is worth keeping: this one
/// did not happen because the call itself was wrong, and the model can fix it
/// on the spot. What it must not be is vague — "invalid params" tells a model
/// nothing, so this names the field and the way to obtain a value for it.
fn incomplete_call(tool: &str, what_happened: &str, wants_revision: bool) -> CallToolResult {
    let mut text = format!("Nothing was written — {what_happened}.\n\n");
    if wants_revision {
        text.push_str(
            "`baseRevision` is the revision you READ, not one to guess or leave out. Read the \
             entity first — knowledge_get_note, or the matching knowledge:// resource, both of \
             which carry `revision` — then send that number back. It is what detects that \
             someone else changed the document while you were working; without it a write \
             silently overwrites whatever they did.\n\n",
        );
    }
    text.push_str(&format!("Supply every required field and call {tool} again."));
    CallToolResult::error(vec![ContentBlock::text(text)])
}

/// "a", "a and b", "a, b and c" — so the message reads as a sentence.
fn english_list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => format!("`{one}`"),
        [rest @ .., last] => format!(
            "{} and `{last}`",
            rest.iter()
                .map(|i| format!("`{i}`"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn explain(err: ServiceError) -> String {
    match err {
        ServiceError::Unreachable(_) => service_down(),
        ServiceError::Timeout => format!("{}\n\n(MADE did not answer in time.)", service_down()),
        ServiceError::ProjectNotOpen => format!(
            "This folder is not open as a project in MADE, so its shared memory is not \
             attached. Open it in MADE, or read {}/ directly.",
            identity::MEMORY_DIR
        ),
        ServiceError::Unauthorized => "MADE refused this adapter's credentials — the registration \
             points at a different MADE install. Re-run the setup in Settings > NexusMind."
            .to_string(),
        ServiceError::Service(e) => e.message,
    }
}

fn unavailable(err: ServiceError, what: &str) -> String {
    format!("Could not read {what}: {}", explain(err))
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/// A note as the file on disk would look: frontmatter, then body.
///
/// The frontmatter is the point. It carries `revision`, which is what an update
/// has to pass as `baseRevision` — putting it in-band means a model that read
/// the resource already has what it needs to write back, with no second call
/// and no invented number.
fn render_note(note: &Value) -> String {
    let meta = note.get("meta").unwrap_or(&Value::Null);
    let body = note.get("content").and_then(Value::as_str).unwrap_or("");
    let text = |key: &str| meta.get(key).and_then(Value::as_str).unwrap_or("");
    let num = |key: &str| meta.get(key).and_then(Value::as_i64).unwrap_or(0);

    let mut out = String::from("---\n");
    out.push_str(&format!("id: {}\n", text("id")));
    out.push_str(&format!("type: {}\n", text("type")));
    out.push_str(&format!("revision: {}\n", num("revision")));
    out.push_str(&format!("created_by: {}\n", byline(meta.get("createdBy"))));
    out.push_str(&format!("updated_by: {}\n", byline(meta.get("updatedBy"))));
    out.push_str(&format!("created_at: {}\n", iso_ms(num("createdAt"))));
    out.push_str(&format!("updated_at: {}\n", iso_ms(num("updatedAt"))));
    let tags: Vec<&str> = meta
        .get("tags")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if tags.is_empty() {
        out.push_str("tags: []\n");
    } else {
        out.push_str("tags:\n");
        for tag in tags {
            out.push_str(&format!("  - {tag}\n"));
        }
    }
    out.push_str("---\n");
    out.push_str(body);
    out
}

/// `updatedBy` is published as `{kind, agentKind?}`, and the frontmatter wants
/// the flat byline the projection uses — the CLI name for an agent, the actor
/// kind otherwise.
fn byline(actor: Option<&Value>) -> String {
    let Some(actor) = actor else {
        return String::new();
    };
    if let Some(text) = actor.as_str() {
        return text.to_string();
    }
    actor
        .get("agentKind")
        .and_then(Value::as_str)
        .or_else(|| actor.get("kind").and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

fn render_changes(changes: &Value) -> String {
    let events = changes.get("events").and_then(Value::as_array);
    let Some(events) = events.filter(|e| !e.is_empty()) else {
        return "No changes recorded yet.".to_string();
    };
    let mut out = String::new();
    for event in events {
        let seq = event.get("seq").and_then(Value::as_i64).unwrap_or(0);
        let when = iso_ms(event.get("createdAt").and_then(Value::as_i64).unwrap_or(0));
        out.push_str(&format!(
            "- `{seq}` {when} · {} · {}\n",
            byline(event.get("actor")),
            event.get("summary").and_then(Value::as_str).unwrap_or("")
        ));
    }
    if let Some(latest) = changes.get("latestSeq").and_then(Value::as_i64) {
        out.push_str(&format!("\nLatest sequence: {latest}\n"));
    }
    out
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// `2026-08-07T09:15:00Z` from epoch-ms — Howard Hinnant's civil-from-days, the
/// same algorithm `knowledge::model::iso_ms` uses. Duplicated rather than
/// imported: it is fifteen lines, and importing it would mean linking the app.
fn iso_ms(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mi, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mi:02}:{ss:02}Z")
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/// Entity ids named in a call, for the audit line.
///
/// Ids only — never the content. This process's stderr is inherited by whatever
/// launched it, so a note body written here would end up in a CLI's log file.
fn notable_ids(params: &Value) -> String {
    let mut ids = Vec::new();
    for key in ["id", "sourceId", "targetId", "kind", "noteType"] {
        if let Some(v) = params.get(key).and_then(Value::as_str) {
            if !v.is_empty() {
                ids.push(format!("{key}={v}"));
            }
        }
    }
    ids.join(" ")
}

fn audit(agent: &str, method: &str, ids: &str, status: &str, elapsed: Duration) {
    eprintln!(
        "[made-knowledge-mcp] agent={agent} method={method} {ids} status={status} ms={}",
        elapsed.as_millis()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::WireErr;

    #[test]
    fn structured_content_is_always_a_record() {
        // The MCP contract: structuredContent is an OBJECT. Claude Code
        // enforces it, and a bare-array reply (knowledge_list_tasks) failed
        // its schema validation in the field (agent-found, 2026-08-08).
        let arr = success(json!([{ "id": "t1" }]));
        let sc = arr.structured_content.expect("structured");
        assert!(sc.is_object(), "arrays must be wrapped: {sc}");
        assert!(sc.get("items").is_some_and(Value::is_array));

        let obj = success(json!({ "status": "ok" }));
        let sc = obj.structured_content.expect("structured");
        assert_eq!(sc.get("status").and_then(Value::as_str), Some("ok"), "objects pass through");

        let scalar = success(json!(7));
        let sc = scalar.structured_content.expect("structured");
        assert!(sc.get("value").is_some(), "scalars must be wrapped: {sc}");
    }

    #[test]
    fn the_catalogue_is_six_reads_and_nine_writes_with_underscore_names() {
        assert_eq!(TOOLS.len(), 15);
        let writes = TOOLS.iter().filter(|t| wire::is_write_method(t.method)).count();
        assert_eq!(writes, 9, "write tool count drifted");
        assert_eq!(TOOLS.len() - writes, 6, "read tool count drifted");

        let mut seen = std::collections::HashSet::new();
        for tool in TOOLS {
            assert!(seen.insert(tool.name), "duplicate tool {}", tool.name);
            // Codex and Gemini both refuse dotted names — this is why the whole
            // surface uses underscores.
            assert!(!tool.name.contains('.'), "{} has a dot", tool.name);
            assert!(tool.name.starts_with("knowledge_"), "{}", tool.name);
            assert!(
                tool.name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == '_'),
                "{} is not a plain snake_case name",
                tool.name
            );
            assert!(!tool.description.is_empty());
        }
    }

    #[test]
    fn every_schema_is_a_closed_object_and_declares_no_identity() {
        for tool in TOOLS {
            let schema = (tool.schema)();
            assert_eq!(schema["type"], "object", "{}", tool.name);
            assert_eq!(
                schema["additionalProperties"], false,
                "{} accepts unknown keys",
                tool.name
            );
            let props = schema["properties"].as_object().expect("properties");
            // Advertising an identity field would invite a model to set it, and
            // the answer would silently be no.
            for forbidden in ["agentKind", "paneId", "sessionId", "actor", "projectKey", "projectId"]
            {
                assert!(
                    !props.contains_key(forbidden),
                    "{} declares {forbidden}",
                    tool.name
                );
            }
        }
    }

    /// The red-team finding this test exists for: `knowledge_update_state` had
    /// `baseRevision` and `content` as OPTIONAL, and the service defaulted the
    /// missing base to the current head. A model that simply left the field out
    /// — which they routinely do for anything marked optional — therefore
    /// compared the head against itself, took the clean-commit branch, and
    /// last-writer-wins over STATE.md with status "ok" and no conflict record.
    ///
    /// So "required" here is not documentation. It is the first of the two
    /// enforcement points, and it must not quietly regress to optional.
    #[test]
    fn replacing_a_document_always_requires_the_revision_it_was_read_at() {
        for name in ["knowledge_update_note", "knowledge_update_state"] {
            let def = find_tool(name).expect(name);
            let schema = (def.schema)();
            let required: Vec<&str> = schema["required"]
                .as_array()
                .expect("required")
                .iter()
                .filter_map(Value::as_str)
                .collect();
            assert!(
                required.contains(&"baseRevision"),
                "{name} must REQUIRE baseRevision, not merely offer it: {required:?}"
            );
            // A missing content is the same defect one step further — it
            // replaces the document with an empty string as a clean write.
            assert!(
                required.contains(&"content"),
                "{name} must require content: {required:?}"
            );
        }

        // Every write tool must require whatever identifies what it writes to;
        // a create has nothing to rebase onto, so it requires its material
        // instead.
        for (name, expected) in [
            ("knowledge_create_note", &["title", "content"][..]),
            ("knowledge_add_decision", &["title", "content"][..]),
            ("knowledge_add_learning", &["title", "content"][..]),
            ("knowledge_create_handoff", &["task"][..]),
            ("knowledge_create_task", &["title"][..]),
            ("knowledge_update_task", &["id"][..]),
            ("knowledge_link_entities", &["sourceId", "targetId"][..]),
        ] {
            let schema = (find_tool(name).expect(name).schema)();
            let required: Vec<&str> = schema["required"]
                .as_array()
                .expect("required")
                .iter()
                .filter_map(Value::as_str)
                .collect();
            for field in expected {
                assert!(required.contains(field), "{name} must require {field}");
            }
        }

        // knowledge_update_task deliberately does NOT require a baseRevision:
        // the service's update_task has no such parameter (it COALESCEs each
        // supplied field over the row), so asking for one would make the model
        // send a number that is silently discarded — a concurrency check that
        // looks present and is not.
        let update_task = (find_tool("knowledge_update_task").unwrap().schema)();
        assert!(
            update_task["properties"].get("baseRevision").is_none(),
            "do not advertise a revision check update_task does not perform"
        );
    }

    #[test]
    fn a_write_missing_its_required_fields_never_leaves_the_adapter() {
        let schema = (find_tool("knowledge_update_state").unwrap().schema)();
        let args = |v: Value| v.as_object().cloned().unwrap();

        // The exact shape the red team found: content supplied, revision left
        // out. This is the call that used to commit.
        let missing = missing_required(&schema, &args(json!({ "content": "# State\n" })));
        assert_eq!(missing, vec!["baseRevision"]);

        // An explicit null is the same omission wearing a value.
        assert_eq!(
            missing_required(&schema, &args(json!({ "content": "x", "baseRevision": null }))),
            vec!["baseRevision"]
        );

        // Both gone.
        let both = missing_required(&schema, &args(json!({ "reason": "tidying up" })));
        assert_eq!(both, vec!["content", "baseRevision"]);

        // A complete call passes untouched — including revision 0, which is a
        // value and not an absence.
        assert!(missing_required(&schema, &args(json!({ "content": "x", "baseRevision": 0 })))
            .is_empty());
        // An empty content is a value someone may have meant; the service
        // accepts it, so this must not invent a stricter rule.
        assert!(missing_required(&schema, &args(json!({ "content": "", "baseRevision": 3 })))
            .is_empty());

        // Reads have no required-field trap to fall into.
        let reads = (find_tool("knowledge_get_latest_handoff").unwrap().schema)();
        assert!(missing_required(&reads, &args(json!({}))).is_empty());
    }

    #[test]
    fn an_incomplete_write_says_which_field_and_where_to_get_it() {
        let result = incomplete_call(
            "knowledge_update_state",
            "knowledge_update_state was called without `baseRevision`",
            true,
        );
        assert_eq!(result.is_error, Some(true), "this genuinely did not happen");
        let text = block_text(&result);
        assert!(text.contains("Nothing was written"), "{text}");
        assert!(text.contains("baseRevision"), "{text}");
        // Naming the field is not enough — the model has to be told how to
        // obtain a correct value for it.
        assert!(text.contains("knowledge_get_note"), "no way to get it: {text}");
        assert!(text.contains("silently overwrites"), "no reason given: {text}");

        // A missing field that is not a revision gets no revision lecture.
        let plain = block_text(&incomplete_call(
            "knowledge_create_task",
            "knowledge_create_task was called without `title`",
            false,
        ));
        assert!(!plain.contains("baseRevision"), "{plain}");
        assert!(plain.contains("call knowledge_create_task again"), "{plain}");
    }

    #[test]
    fn the_service_can_still_refuse_a_call_the_schema_allowed() {
        // The backstop: if the service enforces a rule the schema has not
        // caught up with, the model must still learn which field.
        let result = failure(
            "knowledge_update_state",
            ServiceError::Service(crate::wire::WireErr {
                code: wire::ERR_INVALID_PARAMS.into(),
                // Byte-identical to wire.rs's FIXTURE_INVALID_PARAMS message,
                // so the frame the service sends and the text this renders from
                // stay one thing.
                message: "'baseRevision' is required — read the document first and pass its \
                          revision"
                    .into(),
                data: None,
            }),
        );
        assert_eq!(result.is_error, Some(true));
        let text = block_text(&result);
        assert!(text.contains("baseRevision"), "{text}");
        assert!(text.contains("knowledge_get_note"), "{text}");
    }

    /// Every write waits out the service's full approval window, whatever the
    /// handshake said the policy was.
    ///
    /// The removed optimization read `write_policy` from the handshake — a
    /// value captured once, while the service re-reads it per request. A
    /// project trusted at connect and tightened to `ask` an hour later kept the
    /// short bound, so the adapter gave up at 30s and told the model MADE was
    /// not running, while the service went on to commit the write when the user
    /// approved at t=45s. The model's retry then hit a connection the service
    /// had already granted and committed the same entry twice.
    #[test]
    fn a_write_always_outlasts_the_services_approval_hold() {
        let client = Arc::new(ServiceClient::new(
            crate::service_client::AdapterIdentity {
                agent: "claude".into(),
                cwd: "/nowhere".into(),
                project_root_guess: None,
                pane_id: None,
                endpoint_override: Some(std::path::PathBuf::from("/nonexistent.json")),
            },
        ));
        let server = KnowledgeServer::new(client, "claude".into());

        for tool in TOOLS.iter().filter(|t| wire::is_write_method(t.method)) {
            assert_eq!(
                server.budget(tool.method),
                APPROVAL_TIMEOUT,
                "{} must wait out the 90s approval window",
                tool.name
            );
        }
        assert!(
            APPROVAL_TIMEOUT > Duration::from_secs(90),
            "the whole point of the long budget"
        );

        // Reads never prompt, so they keep the short bound.
        for tool in TOOLS.iter().filter(|t| !wire::is_write_method(t.method)) {
            assert_eq!(server.budget(tool.method), READ_TIMEOUT, "{}", tool.name);
        }
    }

    #[test]
    fn field_lists_read_as_sentences() {
        assert_eq!(english_list(&["a".into()]), "`a`");
        assert_eq!(english_list(&["a".into(), "b".into()]), "`a` and `b`");
        assert_eq!(
            english_list(&["a".into(), "b".into(), "c".into()]),
            "`a`, `b` and `c`"
        );
        assert_eq!(english_list(&[]), "");
    }

    #[test]
    fn a_conflict_is_an_answer_not_an_error() {
        let data = json!({
            "status": "conflict",
            "conflict": { "currentRevision": 4, "currentContent": "# Doc\n\nhead\n" }
        });
        let result = failure(
            "knowledge_update_note",
            ServiceError::Service(WireErr {
                code: wire::ERR_CONFLICT.into(),
                message: "stale".into(),
                data: Some(data.clone()),
            }),
        );
        assert_eq!(result.is_error, Some(false), "a conflict must not read as a failure");
        assert_eq!(result.structured_content, Some(data));
        let text = block_text(&result);
        assert!(text.contains("baseRevision"), "no retry instruction: {text}");
        assert!(text.contains("currentRevision"), "no rebase data: {text}");
    }

    #[test]
    fn denials_and_read_only_explain_the_way_out() {
        let denied = failure(
            "knowledge_create_note",
            ServiceError::Service(WireErr {
                code: wire::ERR_DENIED.into(),
                message: "the user did not approve this write".into(),
                data: None,
            }),
        );
        assert_eq!(denied.is_error, Some(false));
        assert!(block_text(&denied).contains("Settings > NexusMind"));

        let ro = failure(
            "knowledge_update_note",
            ServiceError::Service(WireErr {
                code: wire::ERR_READ_ONLY.into(),
                message: "another MADE instance owns this project".into(),
                data: None,
            }),
        );
        assert_eq!(ro.is_error, Some(false));
        assert!(block_text(&ro).contains("Reads still work"));
    }

    #[test]
    fn a_missing_service_names_the_fallback_that_always_works() {
        let down = failure(
            "knowledge_search",
            ServiceError::Unreachable("no endpoint".into()),
        );
        assert_eq!(down.is_error, Some(true), "this one really did not happen");
        let text = block_text(&down);
        assert!(text.contains("MADE is not running"), "{text}");
        let fallback = format!("{}/", identity::MEMORY_DIR);
        assert!(text.contains(&fallback), "no fallback offered: {text}");

        // A different diagnosis for a different problem: telling someone to
        // start an app that is already running sends them nowhere.
        let closed = failure("knowledge_search", ServiceError::ProjectNotOpen);
        assert!(block_text(&closed).contains("not open as a project"));
    }

    #[test]
    fn a_note_renders_with_the_frontmatter_a_writer_needs() {
        let note = json!({
            "meta": {
                "id": "kn_abc",
                "type": "state",
                "title": "Current state",
                "revision": 7,
                "createdBy": { "kind": "user" },
                "updatedBy": { "kind": "agent", "agentKind": "codex" },
                "createdAt": 1_785_442_320_000i64,
                "updatedAt": 1_785_442_320_000i64,
                "tags": ["core", "state"]
            },
            "content": "# Current state\n\nBody text.\n"
        });
        let md = render_note(&note);
        assert!(md.starts_with("---\n"));
        assert!(md.contains("revision: 7"), "{md}");
        // The agent byline, not the actor kind — the projection stores the CLI
        // name so a reader can tell who wrote it.
        assert!(md.contains("updated_by: codex"), "{md}");
        assert!(md.contains("created_by: user"), "{md}");
        assert!(md.contains("created_at: 2026-07-30T20:12:00Z"), "{md}");
        assert!(md.contains("  - core\n  - state\n"), "{md}");
        assert!(md.ends_with("Body text.\n"));

        let bare = render_note(&json!({ "meta": { "id": "kn_x" }, "content": "" }));
        assert!(bare.contains("tags: []"), "{bare}");
    }

    #[test]
    fn changes_render_even_when_there_are_none() {
        assert!(render_changes(&json!({ "events": [] })).contains("No changes"));
        let rendered = render_changes(&json!({
            "events": [{
                "seq": 12,
                "summary": "updated STATE.md",
                "actor": { "kind": "agent", "agentKind": "claude" },
                "createdAt": 1_785_442_320_000i64
            }],
            "latestSeq": 12
        }));
        assert!(rendered.contains("claude"), "{rendered}");
        assert!(rendered.contains("updated STATE.md"), "{rendered}");
        assert!(rendered.contains("Latest sequence: 12"), "{rendered}");
    }

    #[test]
    fn the_audit_line_never_carries_content() {
        // stderr is inherited by whoever launched this process, so a note body
        // reaching it would land in a CLI's log file.
        let ids = notable_ids(&json!({
            "id": "kn_abc",
            "content": "a secret paragraph the user typed",
            "title": "Also not for the log"
        }));
        assert_eq!(ids, "id=kn_abc");
        assert!(notable_ids(&json!({})).is_empty());
    }

    #[test]
    fn resources_cover_the_core_documents_and_the_change_log() {
        assert_eq!(CORE_RESOURCES.len(), 7);
        for (uri, _, _) in CORE_RESOURCES {
            assert!(uri.starts_with(URI_PREFIX), "{uri}");
        }
        assert!(URI_CHANGES.starts_with(URI_PREFIX));
        assert_eq!(PROMPTS.len(), 4);
    }

    fn block_text(result: &CallToolResult) -> String {
        result
            .content
            .iter()
            .filter_map(|c| match c {
                ContentBlock::Text(t) => Some(t.text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

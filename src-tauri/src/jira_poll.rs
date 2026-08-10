//! Jira Cloud REST v3 polling for ticket-update notifications.
//!
//! MADE's only self-authenticated Jira surface: everything else Jira-related
//! goes through a CLI pane's Atlassian MCP session. This module exists because
//! a background notifier must work with no pane open and no page loaded — the
//! user supplies an API token (id.atlassian.com) + account email, and the
//! frontend engine (JiraNotifyEngine) polls once a minute.
//!
//! Runs in Rust, not the webview: fetch() to *.atlassian.net from the app
//! origin would die on CORS, and reqwest is already a dependency.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// One field a Jira site exposes — the catalogue behind Settings > Jira's
/// "extra details" pickers, and how Organizations / Request type are found
/// without hardcoding a customfield id that differs per site.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraFieldMeta {
    pub id: String,
    pub name: String,
    pub custom: bool,
    /// `schema.custom` when present, else `schema.type` — what identifies a
    /// JSM field by KIND rather than by an id that varies per site.
    pub kind: Option<String>,
}

/// Which non-core fields to fetch and show. Built by the frontend from the
/// user's picks plus the two auto-detected JSM ones, so Rust never has to know
/// what a given site calls them.
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JiraFieldSpec {
    /// JSM "Organizations" — the customer company that raised the ticket.
    pub org: Option<String>,
    /// JSM "Request Type" — which request form/platform it came in on.
    pub request_type: Option<String>,
    /// Anything else the user ticked, kept as id → flattened text.
    #[serde(default)]
    pub extra: Vec<String>,
}

impl JiraFieldSpec {
    /// Every id this spec wants, filtered to what is safe to interpolate and
    /// capped — a hand-edited store must not be able to ask for 500 fields.
    fn ids(&self) -> Vec<&str> {
        let mut out: Vec<&str> = self
            .org
            .iter()
            .chain(self.request_type.iter())
            .map(|s| s.as_str())
            .chain(self.extra.iter().map(|s| s.as_str()))
            .filter(|id| is_valid_field_id(id))
            .collect();
        out.sort_unstable();
        out.dedup();
        out.truncate(25);
        out
    }

    /// The `fields=` value: the always-needed core plus this spec's ids.
    fn query_fields(&self) -> String {
        let ids = self.ids();
        if ids.is_empty() {
            ISSUE_FIELDS.to_string()
        } else {
            format!("{},{}", ISSUE_FIELDS, ids.join(","))
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraMyself {
    pub display_name: String,
    pub account_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraCommentBrief {
    pub id: String,
    pub author: String,
    pub author_account_id: Option<String>,
    pub created: String,
    /// Plain text extracted from the ADF body, ≤ 200 chars.
    pub snippet: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraTicketState {
    pub key: String,
    pub summary: String,
    pub status: String,
    /// `statusCategory.key`: "new" | "indeterminate" | "done". Rides INSIDE the
    /// `status` object we already request — it is NOT a `fields=` entry of its
    /// own, and asking for one 400s on stricter instances.
    pub status_category: Option<String>,
    pub assignee_name: Option<String>,
    pub assignee_account_id: Option<String>,
    pub reporter_name: Option<String>,
    /// Priority scheme NAME ("High"). Jira's search response carries no rank,
    /// and the id only happens to be 1..5 highest→lowest on the default
    /// scheme — custom schemes number arbitrarily. The id is a tiebreak, not
    /// an ordering.
    pub priority_name: Option<String>,
    pub priority_id: Option<String>,
    /// Jira Service Management "Organizations" — the customer company that
    /// raised the ticket. A CUSTOM field whose id differs per site, so it is
    /// only requested once the caller has resolved the id out of
    /// `jira_site_meta`. Several organizations on one issue join with ", ".
    pub organization: Option<String>,
    /// JSM "Request Type" — which request form the ticket came in on.
    pub request_type: Option<String>,
    /// Everything else the user picked, keyed by field id and already
    /// flattened to display text (see `read_field_text`).
    pub extra: HashMap<String, String>,
    pub created: String,
    pub updated: String,
    /// Only populated for watched keys whose `updated` moved past the
    /// caller-supplied snapshot — that is the only time the extra comment
    /// request is spent.
    pub last_comment: Option<JiraCommentBrief>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraPollResult {
    pub tickets: Vec<JiraTicketState>,
    pub assigned: Vec<JiraTicketState>,
}

/// Typed failure the engine can branch on: "auth" stops polling until the
/// credentials change, "rate" backs off, "network" is silently skipped.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraApiError {
    pub kind: String,
    pub status: Option<u16>,
    pub message: String,
}

impl JiraApiError {
    fn config(msg: impl Into<String>) -> Self {
        Self { kind: "config".into(), status: None, message: msg.into() }
    }
    fn network(e: reqwest::Error) -> Self {
        Self { kind: "network".into(), status: None, message: e.to_string() }
    }
    fn from_status(status: u16, body: String) -> Self {
        let kind = match status {
            401 | 403 => "auth",
            429 => "rate",
            _ => "http",
        };
        Self { kind: kind.into(), status: Some(status), message: body }
    }
}

/// `SUPPORT` shape check — a Jira project key on its own. Interpolated into
/// the unassigned query's `project in (…)`, so anything failing this is
/// DROPPED rather than escaped. Length-capped because no real project key is
/// remotely this long and an unbounded one is just a bigger JQL string.
fn is_valid_project_key(k: &str) -> bool {
    if k.is_empty() || k.len() > 32 {
        return false;
    }
    let mut chars = k.chars();
    let Some(first) = chars.next() else { return false };
    first.is_ascii_uppercase()
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// `PROJ-123` shape check. Every watched key goes into a JQL string, so
/// anything that fails this is DROPPED rather than escaped — there is no
/// legitimate ticket key outside this alphabet.
///
/// It ALSO guards `jira_assign_issue`, where the key lands in the URL *path* —
/// there it is path-rewrite defence (`FOO/../../../myself`), not JQL defence.
/// Do not relax it on the assumption that JQL is the only caller.
fn is_valid_ticket_key(key: &str) -> bool {
    let Some((proj, num)) = key.split_once('-') else { return false };
    is_valid_project_key(proj) && !num.is_empty() && num.chars().all(|c| c.is_ascii_digit())
}

/// JQL `ORDER BY` clause from a caller-supplied sort key.
///
/// The sort lives in the JQL rather than being applied client-side because the
/// result page is TRUNCATED (`maxResults`). Sorting the newest 50 rows by
/// "oldest first" in JS shows the oldest of the newest 50 — plausible-looking
/// garbage. Pushing it into the query makes the truncation window match what
/// the user actually asked for.
///
/// UNKNOWN KEYS FALL BACK. The sort setting is persisted user state; a
/// hand-edited store must not be able to write JQL.
fn order_clause(key: Option<&str>, dir: Option<&str>) -> String {
    let field = match key.unwrap_or("created") {
        "updated" => "updated",
        "priority" => "priority",
        "status" => "status",
        "key" => "key",
        "summary" => "summary",
        _ => "created",
    };
    let dir = if dir == Some("asc") { "ASC" } else { "DESC" };
    format!("ORDER BY {field} {dir}")
}

/// JQL for one of the BROWSE-ONLY queues.
///
/// These two are grouped behind one builder because they share everything that
/// matters operationally: neither feeds notifications from the main cycle,
/// both are visibility-gated and sub-cadenced, and both must be unable to take
/// the watched/assigned results down with them.
///
/// `kind` is a CLOSED SET — an unknown value yields None rather than a query,
/// because it arrives from persisted frontend state.
///
/// Callers must have filtered `projects` through `is_valid_project_key` first;
/// this only builds the string. Kept pure so the injection case is a unit test.
fn queue_jql(kind: &str, projects: &[&str], order: &str) -> Option<String> {
    match kind {
        "unassigned" => Some(format!(
            "project in ({}) AND assignee IS EMPTY AND statusCategory != Done {order}",
            projects.join(",")
        )),
        // Assigned to me AND finished — the Assigned tab's "Done" mini tab.
        // Not project-scoped: what you closed is yours wherever it lives, and
        // it mirrors the open assigned query, which is site-wide too.
        "assignedDone" => Some(format!(
            "assignee = currentUser() AND statusCategory = Done {order}"
        )),
        _ => None,
    }
}

/// Base URL sanity: https?://host with a dot, no trailing slash kept.
fn normalize_base(base_url: &str) -> Result<String, JiraApiError> {
    let b = base_url.trim().trim_end_matches('/');
    if !(b.starts_with("https://") || b.starts_with("http://")) || !b.contains('.') {
        return Err(JiraApiError::config(format!("not a Jira site URL: {base_url}")));
    }
    Ok(b.to_string())
}

/// One process-wide client, so the connection pool survives between commands.
/// `reqwest::Client` is `Arc` inside — cloning is cheap, and sharing it means
/// the per-cycle searches (watched + assigned + unassigned, all to the same
/// host) stop paying for a fresh TLS handshake each.
static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn client() -> Result<reqwest::Client, JiraApiError> {
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let built = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(JiraApiError::network)?;
    Ok(CLIENT.get_or_init(|| built).clone())
}

/// Minimal RFC 3986 query-value percent-encoder (unreserved chars pass).
/// reqwest 0.13's `.query()` sits behind a feature this build doesn't enable,
/// and these three endpoints need nothing fancier.
fn enc(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for b in v.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

async fn get_json(
    client: &reqwest::Client,
    url: &str,
    email: &str,
    token: &str,
) -> Result<serde_json::Value, JiraApiError> {
    let resp = client
        .get(url)
        .basic_auth(email, Some(token))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(JiraApiError::network)?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        let brief: String = body.chars().take(300).collect();
        return Err(JiraApiError::from_status(status, brief));
    }
    resp.json::<serde_json::Value>().await.map_err(JiraApiError::network)
}

/// Write sibling to `get_json`. Tolerates **204 No Content**, which is what the
/// assignee endpoint returns on success — `resp.json()` would blow up on the
/// empty body, so this never parses one.
///
/// Serializes by hand into `.body(String)` with an explicit Content-Type
/// rather than `RequestBuilder::json()`: `Cargo.toml` pins reqwest with
/// `default-features = false`, and a write path should not bet on a feature
/// arriving through unification (same reasoning as the hand-rolled `enc`).
async fn send_json_no_content(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    email: &str,
    token: &str,
    body: &serde_json::Value,
) -> Result<(), JiraApiError> {
    let resp = client
        .request(method, url)
        .basic_auth(email, Some(token))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(body).unwrap_or_else(|_| "{}".into()))
        .send()
        .await
        .map_err(JiraApiError::network)?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        let brief: String = body.chars().take(300).collect();
        return Err(JiraApiError::from_status(status, brief));
    }
    Ok(())
}

/// Flatten an ADF (Atlassian Document Format) node tree to plain text.
/// Collect `text` leaves, newline on hardBreak and between top-level blocks;
/// everything else recurses through `content`. Truncated to 200 chars on a
/// char boundary by the caller-facing wrapper.
fn adf_to_text(node: &serde_json::Value, out: &mut String) {
    match node {
        serde_json::Value::Object(obj) => {
            match obj.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = obj.get("text").and_then(|t| t.as_str()) {
                        out.push_str(t);
                    }
                }
                Some("hardBreak") => out.push('\n'),
                _ => {
                    if let Some(content) = obj.get("content").and_then(|c| c.as_array()) {
                        for (i, child) in content.iter().enumerate() {
                            // Block boundaries read as line breaks; inline runs don't.
                            if i > 0
                                && obj.get("type").and_then(|t| t.as_str()) == Some("doc")
                                && !out.is_empty()
                                && !out.ends_with('\n')
                            {
                                out.push('\n');
                            }
                            adf_to_text(child, out);
                        }
                    }
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for child in arr {
                adf_to_text(child, out);
            }
        }
        _ => {}
    }
}

fn adf_snippet(body: &serde_json::Value) -> String {
    let mut out = String::new();
    adf_to_text(body, &mut out);
    let trimmed = out.trim();
    if trimmed.chars().count() <= 200 {
        trimmed.to_string()
    } else {
        let cut: String = trimmed.chars().take(199).collect();
        format!("{cut}…")
    }
}

/// A custom-field id is safe to interpolate into the `fields=` query.
///
/// The id comes from Jira's own /field response rather than the user, but it
/// crosses the frontend (persisted, so a hand-edited store could carry
/// anything) before it comes back here — so it is re-checked at the boundary
/// it is actually used at, exactly like the ticket keys.
fn is_valid_field_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Flatten an arbitrary Jira field value into one line of display text.
///
/// Jira fields are wildly polymorphic — a string, a number, `{name}`,
/// `{value}`, `{displayName}`, an array of any of those — and which one you
/// get depends on how the site models the field. Every shape carrying readable
/// text is accepted; anything else (an ADF document, a nested object with no
/// obvious label) is DROPPED rather than rendered as raw JSON, because a row of
/// `[object Object]` is worse than an empty column.
fn read_field_text(v: &serde_json::Value) -> Option<String> {
    fn one(v: &serde_json::Value) -> Option<String> {
        match v {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            serde_json::Value::Bool(b) => Some(b.to_string()),
            serde_json::Value::Object(o) => o
                .get("name")
                .or_else(|| o.get("value"))
                .or_else(|| o.get("displayName"))
                .or_else(|| o.get("requestType").and_then(|r| r.get("name")))
                .and_then(|x| x.as_str())
                .map(|x| x.to_string()),
            _ => None,
        }
    }
    let joined = match v {
        serde_json::Value::Array(arr) => {
            arr.iter().filter_map(one).collect::<Vec<_>>().join(", ")
        }
        other => one(other).unwrap_or_default(),
    };
    let t = joined.trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}

/// One issue object from /search/jql → JiraTicketState (no comment yet).
fn parse_issue(issue: &serde_json::Value, spec: &JiraFieldSpec) -> Option<JiraTicketState> {
    let key = issue.get("key")?.as_str()?.to_string();
    let fields = issue.get("fields")?;
    let s = |v: &serde_json::Value, k: &str| -> Option<String> {
        v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string())
    };
    // `status` is read twice now (name + nested category), so hoist it.
    let status = fields.get("status").filter(|x| !x.is_null());
    let assignee = fields.get("assignee").filter(|a| !a.is_null());
    let reporter = fields.get("reporter").filter(|r| !r.is_null());
    let priority = fields.get("priority").filter(|p| !p.is_null());
    Some(JiraTicketState {
        key,
        summary: s(fields, "summary").unwrap_or_default(),
        status: status
            .and_then(|st| st.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or_default()
            .to_string(),
        status_category: status
            .and_then(|st| st.get("statusCategory"))
            .and_then(|sc| sc.get("key"))
            .and_then(|k| k.as_str())
            .map(|k| k.to_string()),
        assignee_name: assignee.and_then(|a| s(a, "displayName")),
        assignee_account_id: assignee.and_then(|a| s(a, "accountId")),
        reporter_name: reporter.and_then(|r| s(r, "displayName")),
        priority_name: priority.and_then(|p| s(p, "name")),
        priority_id: priority.and_then(|p| s(p, "id")),
        organization: spec
            .org
            .as_deref()
            .and_then(|f| fields.get(f))
            .and_then(read_field_text),
        request_type: spec
            .request_type
            .as_deref()
            .and_then(|f| fields.get(f))
            .and_then(read_field_text),
        extra: spec
            .extra
            .iter()
            .filter_map(|id| {
                let text = fields.get(id).and_then(read_field_text)?;
                Some((id.clone(), text))
            })
            .collect(),
        created: s(fields, "created").unwrap_or_default(),
        updated: s(fields, "updated").unwrap_or_default(),
        last_comment: None,
    })
}

/// Everything every Jira list in MADE needs, in one place — all three queries
/// (watched, assigned, unassigned) go through this function, so widening it
/// feeds all three at once. `statusCategory` is deliberately absent: it comes
/// nested inside `status`, and naming it here 400s on stricter instances.
const ISSUE_FIELDS: &str = "summary,status,assignee,reporter,priority,created,updated";

async fn search_issues(
    client: &reqwest::Client,
    base: &str,
    email: &str,
    token: &str,
    jql: &str,
    max_results: &str,
    spec: &JiraFieldSpec,
) -> Result<Vec<JiraTicketState>, JiraApiError> {
    // Extra fields are only asked for once the frontend has resolved their
    // per-site ids from the catalogue: naming a field a site does not have
    // 400s the WHOLE search, taking the core columns down with it.
    let url = format!(
        "{base}/rest/api/3/search/jql?jql={}&fields={}&maxResults={max_results}",
        enc(jql),
        spec.query_fields(),
    );
    let v = get_json(client, &url, email, token).await?;
    Ok(v.get("issues")
        .and_then(|i| i.as_array())
        .map(|arr| arr.iter().filter_map(|i| parse_issue(i, spec)).collect())
        .unwrap_or_default())
}

/// One site's metadata: what it can show, and how it ranks priority.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraSiteMeta {
    pub fields: Vec<JiraFieldMeta>,
    /// Priority NAMES in Jira's own order, most urgent first. Jira's search
    /// response carries no rank, and the numeric id is only conventionally
    /// ordered — a site with a custom scheme numbers them arbitrarily. This is
    /// the authoritative order, so the client sort can stop guessing.
    pub priorities: Vec<String>,
}

/// Everything this site can show on a ticket.
///
/// One request, cached by the caller for the life of the store. It serves two
/// jobs: it populates the Settings pickers ("add any detail you like"), and it
/// is how Organizations and Request type are located WITHOUT hardcoding a
/// `customfield_10002` that differs per site — the frontend matches them on
/// `kind` (the schema's custom type), which is the field's real identity.
///
/// Fields with no usable id are dropped; a site with no JSM simply has no
/// matching kinds and those two columns never appear.
#[tauri::command]
pub async fn jira_site_meta(
    base_url: String,
    email: String,
    token: String,
) -> Result<JiraSiteMeta, JiraApiError> {
    let base = normalize_base(&base_url)?;
    let client = client()?;
    // Priority order is best-effort: a site that denies this endpoint still
    // gets its field catalogue, and the client falls back to name heuristics.
    let priorities = match get_json(
        &client,
        &format!("{base}/rest/api/3/priority"),
        &email,
        &token,
    )
    .await
    {
        Ok(p) => p
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.get("name").and_then(|n| n.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let v = get_json(&client, &format!("{base}/rest/api/3/field"), &email, &token).await?;
    let Some(fields) = v.as_array() else {
        return Ok(JiraSiteMeta { fields: Vec::new(), priorities });
    };
    let fields = fields
        .iter()
        .filter_map(|f| {
            let id = f.get("id").and_then(|i| i.as_str())?;
            if !is_valid_field_id(id) {
                return None;
            }
            let schema = f.get("schema");
            Some(JiraFieldMeta {
                id: id.to_string(),
                name: f
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or(id)
                    .to_string(),
                custom: f.get("custom").and_then(|c| c.as_bool()).unwrap_or(false),
                kind: schema
                    .and_then(|s| s.get("custom").or_else(|| s.get("type")))
                    .and_then(|c| c.as_str())
                    .map(|c| c.to_string()),
            })
        })
        .collect();
    Ok(JiraSiteMeta { fields, priorities })
}

async fn last_comment(
    client: &reqwest::Client,
    base: &str,
    email: &str,
    token: &str,
    key: &str,
) -> Result<Option<JiraCommentBrief>, JiraApiError> {
    let url = format!("{base}/rest/api/3/issue/{key}/comment?orderBy=-created&maxResults=1");
    let v = get_json(client, &url, email, token).await?;
    let Some(c) = v
        .get("comments")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
    else {
        return Ok(None);
    };
    let author = c.get("author");
    Ok(Some(JiraCommentBrief {
        id: c
            .get("id")
            .and_then(|i| i.as_str())
            .unwrap_or_default()
            .to_string(),
        author: author
            .and_then(|a| a.get("displayName"))
            .and_then(|d| d.as_str())
            .unwrap_or_default()
            .to_string(),
        author_account_id: author
            .and_then(|a| a.get("accountId"))
            .and_then(|d| d.as_str())
            .map(|s| s.to_string()),
        created: c
            .get("created")
            .and_then(|d| d.as_str())
            .unwrap_or_default()
            .to_string(),
        snippet: c.get("body").map(adf_snippet).unwrap_or_default(),
    }))
}

/// Settings "Test" button + first-run accountId capture (self-comment filter).
#[tauri::command]
pub async fn jira_test_auth(
    base_url: String,
    email: String,
    token: String,
) -> Result<JiraMyself, JiraApiError> {
    let base = normalize_base(&base_url)?;
    let client = client()?;
    let url = format!("{base}/rest/api/3/myself");
    let v = get_json(&client, &url, &email, &token).await?;
    Ok(JiraMyself {
        display_name: v
            .get("displayName")
            .and_then(|d| d.as_str())
            .unwrap_or_default()
            .to_string(),
        account_id: v
            .get("accountId")
            .and_then(|d| d.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

/// One poll cycle. Steady-state cost is one search request (plus one when
/// `include_assigned`); the per-ticket comment request is only spent on keys
/// whose `updated` moved past the caller's snapshot.
#[tauri::command]
pub async fn jira_poll(
    base_url: String,
    email: String,
    token: String,
    keys: Vec<String>,
    prev_updated: HashMap<String, String>,
    include_assigned: bool,
    fields: Option<JiraFieldSpec>,
) -> Result<JiraPollResult, JiraApiError> {
    let base = normalize_base(&base_url)?;
    let client = client()?;

    let valid: Vec<&str> = keys
        .iter()
        .map(|k| k.as_str())
        .filter(|k| is_valid_ticket_key(k))
        .take(100)
        .collect();

    let spec = fields.unwrap_or_default();
    let mut tickets: Vec<JiraTicketState> = Vec::new();
    if !valid.is_empty() {
        let jql = format!("key in ({})", valid.join(","));
        tickets = search_issues(&client, &base, &email, &token, &jql, "100", &spec).await?;
        for t in tickets.iter_mut() {
            let changed = prev_updated.get(&t.key).map(|p| p != &t.updated).unwrap_or(true);
            if changed {
                t.last_comment = last_comment(&client, &base, &email, &token, &t.key).await?;
            }
        }
    }

    let assigned = if include_assigned {
        search_issues(
            &client,
            &base,
            &email,
            &token,
            "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
            "50",
            &spec,
        )
        .await?
    } else {
        Vec::new()
    };

    Ok(JiraPollResult { tickets, assigned })
}

/// One of the browse-only queues: the unassigned backlog, or your resolved
/// tickets.
///
/// SEPARATE from `jira_poll` on purpose. A bad project key or a missing Browse
/// permission 400s here, and that must never cost the caller its watched or
/// assigned results — the notifications people actually depend on. A separate
/// command means a separate `invoke` and a separate `catch`, instead of
/// leaking an error field into `JiraPollResult`'s happy path.
///
/// Takes a `kind` and project KEYS, never raw JQL: the frontend supplies
/// validated identifiers and Rust owns the query string.
#[tauri::command]
pub async fn jira_search_queue(
    base_url: String,
    email: String,
    token: String,
    kind: String,
    project_keys: Vec<String>,
    sort_key: Option<String>,
    sort_dir: Option<String>,
    fields: Option<JiraFieldSpec>,
) -> Result<Vec<JiraTicketState>, JiraApiError> {
    let base = normalize_base(&base_url)?;
    let mut valid: Vec<&str> = project_keys
        .iter()
        .map(|k| k.as_str())
        .filter(|k| is_valid_project_key(k))
        .collect();
    // Sorted + deduped so the query string is stable across cycles.
    valid.sort_unstable();
    valid.dedup();
    valid.truncate(20);
    // `project in ()` is a JQL syntax error, not an empty result — an
    // all-invalid list is an empty queue, so don't spend a request on it.
    // Only the project-scoped kind cares; "assignedDone" is site-wide.
    if kind == "unassigned" && valid.is_empty() {
        return Ok(Vec::new());
    }
    let order = order_clause(sort_key.as_deref(), sort_dir.as_deref());
    let Some(jql) = queue_jql(&kind, &valid, &order) else {
        return Err(JiraApiError::config(format!("unknown queue: {kind}")));
    };
    let client = client()?;
    search_issues(&client, &base, &email, &token, &jql, "50", &fields.unwrap_or_default()).await
}

/// Assign an issue. `account_id: None` unassigns — the same endpoint, and the
/// only way back out of a mis-click.
///
/// `key` lands in the URL PATH, so the `is_valid_ticket_key` gate below is
/// path-rewrite defence, not JQL defence. Success is 204 No Content.
#[tauri::command]
pub async fn jira_assign_issue(
    base_url: String,
    email: String,
    token: String,
    key: String,
    account_id: Option<String>,
) -> Result<(), JiraApiError> {
    let base = normalize_base(&base_url)?;
    if !is_valid_ticket_key(&key) {
        return Err(JiraApiError::config(format!("not a ticket key: {key}")));
    }
    let client = client()?;
    let url = format!("{base}/rest/api/3/issue/{key}/assignee");
    // An empty string is "no account id captured yet", not "unassign" — treat
    // it as null so a blank never silently un-assigns someone else's ticket.
    let body = serde_json::json!({ "accountId": account_id.filter(|a| !a.is_empty()) });
    send_json_no_content(&client, reqwest::Method::PUT, &url, &email, &token, &body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_key_validation() {
        assert!(is_valid_ticket_key("PROJ-123"));
        assert!(is_valid_ticket_key("A2B_X-1"));
        assert!(!is_valid_ticket_key("proj-1"));
        assert!(!is_valid_ticket_key("PROJ-"));
        assert!(!is_valid_ticket_key("PROJ"));
        assert!(!is_valid_ticket_key("PROJ-1) OR (key in (X-1"));
        assert!(!is_valid_ticket_key("-1"));
    }

    #[test]
    fn project_key_validation() {
        assert!(is_valid_project_key("SUPPORT"));
        assert!(is_valid_project_key("A2B_X"));
        assert!(!is_valid_project_key("Support"));
        assert!(!is_valid_project_key(""));
        assert!(!is_valid_project_key("SUP-1"));
        // The whole point: nothing that could close the paren and open a new clause.
        assert!(!is_valid_project_key("SUP) OR (project in (X"));
        assert!(!is_valid_project_key(&"A".repeat(33)));
        assert!(is_valid_project_key(&"A".repeat(32)));
    }

    #[test]
    fn queue_jql_shapes() {
        assert_eq!(
            queue_jql("unassigned", &["DEV", "SUPPORT"], "ORDER BY created DESC").unwrap(),
            "project in (DEV,SUPPORT) AND assignee IS EMPTY AND statusCategory != Done ORDER BY created DESC"
        );
        assert_eq!(
            queue_jql("assignedDone", &[], "ORDER BY updated DESC").unwrap(),
            "assignee = currentUser() AND statusCategory = Done ORDER BY updated DESC"
        );
        // Closed set: persisted frontend state cannot invent a query.
        assert!(queue_jql("everything", &["DEV"], "ORDER BY created DESC").is_none());
    }

    #[test]
    fn order_clause_falls_back() {
        assert_eq!(order_clause(Some("updated"), Some("asc")), "ORDER BY updated ASC");
        assert_eq!(order_clause(Some("priority"), None), "ORDER BY priority DESC");
        // Persisted user state must not be able to write JQL.
        assert_eq!(order_clause(Some("'; DROP"), Some("x")), "ORDER BY created DESC");
        assert_eq!(order_clause(None, None), "ORDER BY created DESC");
    }

    #[test]
    fn parse_issue_extracts_new_fields() {
        let issue: serde_json::Value = serde_json::json!({
            "key": "SUPPORT-24920",
            "fields": {
                "summary": "Kunden kan inte logga in",
                "status": { "name": "In Progress",
                            "statusCategory": { "key": "indeterminate" } },
                "assignee": serde_json::Value::Null,
                "reporter": { "displayName": "Anna Berg", "accountId": "acc-1" },
                "priority": { "name": "High", "id": "2" },
                "customfield_10002": [{ "id": 7, "name": "Acme AB" }],
                "customfield_10010": { "requestType": { "name": "Report a problem" } },
                "customfield_10050": "Windows",
                "created": "2026-08-01T09:00:00.000+0200",
                "updated": "2026-08-10T11:30:00.000+0200"
            }
        });
        let spec = JiraFieldSpec {
            org: Some("customfield_10002".into()),
            request_type: Some("customfield_10010".into()),
            extra: vec!["customfield_10050".into()],
        };
        let t = parse_issue(&issue, &spec).expect("parses");
        assert_eq!(t.key, "SUPPORT-24920");
        assert_eq!(t.status, "In Progress");
        assert_eq!(t.status_category.as_deref(), Some("indeterminate"));
        assert_eq!(t.assignee_name, None);
        assert_eq!(t.reporter_name.as_deref(), Some("Anna Berg"));
        assert_eq!(t.priority_name.as_deref(), Some("High"));
        assert_eq!(t.priority_id.as_deref(), Some("2"));
        assert_eq!(t.organization.as_deref(), Some("Acme AB"));
        assert_eq!(t.request_type.as_deref(), Some("Report a problem"));
        assert_eq!(t.extra.get("customfield_10050").map(String::as_str), Some("Windows"));
        assert_eq!(t.created, "2026-08-01T09:00:00.000+0200");
    }

    #[test]
    fn field_spec_builds_a_safe_query() {
        let spec = JiraFieldSpec {
            org: Some("customfield_10002".into()),
            request_type: None,
            // Duplicates collapse, and anything that could smuggle a second
            // query parameter or extra field is dropped, not escaped.
            extra: vec![
                "customfield_10002".into(),
                "customfield_10050".into(),
                "bad&maxResults=9999".into(),
                "a,b".into(),
            ],
        };
        assert_eq!(spec.ids(), vec!["customfield_10002", "customfield_10050"]);
        let q = spec.query_fields();
        assert!(q.starts_with(ISSUE_FIELDS));
        assert!(q.ends_with(",customfield_10002,customfield_10050"));
        assert!(!q.contains("maxResults"));
        // An empty spec asks for exactly the core fields — never a trailing comma.
        assert_eq!(JiraFieldSpec::default().query_fields(), ISSUE_FIELDS);
    }

    #[test]
    fn field_text_accepts_every_shape_jira_sends() {
        use serde_json::json;
        assert_eq!(
            read_field_text(&json!([{ "id": 1, "name": "Acme AB" }, { "id": 2, "name": "Beta Oy" }])),
            Some("Acme AB, Beta Oy".to_string())
        );
        assert_eq!(read_field_text(&json!("Acme AB")), Some("Acme AB".to_string()));
        assert_eq!(read_field_text(&json!({ "value": "Acme AB" })), Some("Acme AB".to_string()));
        assert_eq!(read_field_text(&json!(["Acme AB"])), Some("Acme AB".to_string()));
        // Empty and unreadable shapes drop out rather than rendering as JSON.
        assert_eq!(read_field_text(&json!([])), None);
        assert_eq!(read_field_text(&serde_json::Value::Null), None);
        assert_eq!(read_field_text(&json!([{ "id": 1 }])), None);
    }

    #[test]
    fn field_id_validation() {
        assert!(is_valid_field_id("customfield_10002"));
        assert!(is_valid_field_id("summary"));
        assert!(!is_valid_field_id(""));
        // Nothing that could add a second query parameter or a new field.
        assert!(!is_valid_field_id("summary,assignee"));
        assert!(!is_valid_field_id("a&maxResults=9999"));
        assert!(!is_valid_field_id(&"a".repeat(41)));
    }

    #[test]
    fn parse_issue_tolerates_missing_optionals() {
        // A minimal issue: no priority, no reporter, no statusCategory, no
        // created. Every one of these is absent on some Jira configuration.
        let issue: serde_json::Value = serde_json::json!({
            "key": "DEV-1",
            "fields": { "summary": "x", "status": { "name": "To Do" },
                        "updated": "2026-08-10T11:30:00.000+0200" }
        });
        let spec = JiraFieldSpec {
            org: Some("customfield_10002".into()),
            request_type: Some("customfield_10010".into()),
            extra: vec!["customfield_10050".into()],
        };
        let t = parse_issue(&issue, &spec).expect("parses");
        assert_eq!(t.status_category, None);
        assert_eq!(t.priority_name, None);
        assert_eq!(t.reporter_name, None);
        assert_eq!(t.created, "");
    }

    #[test]
    fn adf_walker_extracts_text() {
        let body: serde_json::Value = serde_json::json!({
            "type": "doc",
            "content": [
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "Hello " },
                    { "type": "text", "text": "world" },
                    { "type": "hardBreak" },
                    { "type": "text", "text": "again" }
                ]},
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "second block" }
                ]}
            ]
        });
        assert_eq!(adf_snippet(&body), "Hello world\nagain\nsecond block");
    }
}

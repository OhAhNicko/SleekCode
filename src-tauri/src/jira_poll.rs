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

use serde::Serialize;

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
    pub assignee_name: Option<String>,
    pub assignee_account_id: Option<String>,
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

/// `PROJ-123` shape check. Every watched key goes into a JQL string, so
/// anything that fails this is DROPPED rather than escaped — there is no
/// legitimate ticket key outside this alphabet.
fn is_valid_ticket_key(key: &str) -> bool {
    let Some((proj, num)) = key.split_once('-') else { return false };
    let mut chars = proj.chars();
    let Some(first) = chars.next() else { return false };
    first.is_ascii_uppercase()
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !num.is_empty()
        && num.chars().all(|c| c.is_ascii_digit())
}

/// Base URL sanity: https?://host with a dot, no trailing slash kept.
fn normalize_base(base_url: &str) -> Result<String, JiraApiError> {
    let b = base_url.trim().trim_end_matches('/');
    if !(b.starts_with("https://") || b.starts_with("http://")) || !b.contains('.') {
        return Err(JiraApiError::config(format!("not a Jira site URL: {base_url}")));
    }
    Ok(b.to_string())
}

fn client() -> Result<reqwest::Client, JiraApiError> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(JiraApiError::network)
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

/// One issue object from /search/jql → JiraTicketState (no comment yet).
fn parse_issue(issue: &serde_json::Value) -> Option<JiraTicketState> {
    let key = issue.get("key")?.as_str()?.to_string();
    let fields = issue.get("fields")?;
    let s = |v: &serde_json::Value, k: &str| -> Option<String> {
        v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string())
    };
    let assignee = fields.get("assignee").filter(|a| !a.is_null());
    Some(JiraTicketState {
        key,
        summary: s(fields, "summary").unwrap_or_default(),
        status: fields
            .get("status")
            .and_then(|st| st.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or_default()
            .to_string(),
        assignee_name: assignee.and_then(|a| s(a, "displayName")),
        assignee_account_id: assignee.and_then(|a| s(a, "accountId")),
        updated: s(fields, "updated").unwrap_or_default(),
        last_comment: None,
    })
}

async fn search_issues(
    client: &reqwest::Client,
    base: &str,
    email: &str,
    token: &str,
    jql: &str,
    max_results: &str,
) -> Result<Vec<JiraTicketState>, JiraApiError> {
    let url = format!(
        "{base}/rest/api/3/search/jql?jql={}&fields=summary,status,assignee,updated&maxResults={max_results}",
        enc(jql),
    );
    let v = get_json(client, &url, email, token).await?;
    Ok(v.get("issues")
        .and_then(|i| i.as_array())
        .map(|arr| arr.iter().filter_map(parse_issue).collect())
        .unwrap_or_default())
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
) -> Result<JiraPollResult, JiraApiError> {
    let base = normalize_base(&base_url)?;
    let client = client()?;

    let valid: Vec<&str> = keys
        .iter()
        .map(|k| k.as_str())
        .filter(|k| is_valid_ticket_key(k))
        .take(100)
        .collect();

    let mut tickets: Vec<JiraTicketState> = Vec::new();
    if !valid.is_empty() {
        let jql = format!("key in ({})", valid.join(","));
        tickets = search_issues(&client, &base, &email, &token, &jql, "100").await?;
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
        )
        .await?
    } else {
        Vec::new()
    };

    Ok(JiraPollResult { tickets, assigned })
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

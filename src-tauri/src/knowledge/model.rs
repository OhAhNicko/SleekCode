//! Payload types and the small primitives every other knowledge module shares:
//! ids, hashing, and the epoch-ms <-> ISO-8601 boundary.
//!
//! Timestamps are INTEGER epoch-ms UTC everywhere — in SQL, in command payloads
//! and on the wire, so JS gets something `new Date(n)` accepts directly. The
//! ONLY place an ISO string appears is markdown frontmatter, where a human has
//! to read it; `iso_ms` / `parse_iso` are that boundary and nothing else should
//! call them.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/// FNV-1a-64, lowercase hex. The ONE hash in this module — content change
/// detection, the self-write ledger, sync_state and the DB filename all use it.
///
/// Hand-rolled rather than `DefaultHasher` because these values are PERSISTED:
/// std's hasher makes no stability guarantee across Rust versions, so a
/// toolchain bump would silently invalidate every stored hash and make every
/// file look externally edited. Hand-rolled rather than a crypto hash because
/// this is change detection, not a security boundary — anything able to
/// engineer a collision here can already write the file directly.
pub fn fnv1a64(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// `fnv1a64` over a string's bytes.
pub fn hash_str(s: &str) -> String {
    fnv1a64(s.as_bytes())
}

// ---------------------------------------------------------------------------
// Ids and time
// ---------------------------------------------------------------------------

pub const ID_NOTE: &str = "kn_";
pub const ID_RELATION: &str = "rel_";
pub const ID_CONFLICT: &str = "cfl_";
pub const ID_HANDOFF: &str = "ho_";
pub const ID_TASK: &str = "tk_";

/// `kn_` + a v4 uuid with the dashes stripped.
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}{}", uuid::Uuid::new_v4().simple())
}

/// True for a well-formed id of the given family — 32 lowercase hex after the
/// prefix. Used when adopting a file whose frontmatter carries an id we have
/// never seen: a valid-looking id is preserved, anything else is re-minted.
pub fn is_valid_id(id: &str, prefix: &str) -> bool {
    match id.strip_prefix(prefix) {
        Some(rest) => rest.len() == 32 && rest.bytes().all(|b| b.is_ascii_hexdigit()),
        None => false,
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The user's UTC offset in minutes east, pushed from the frontend at boot
/// (`knowledge_set_timezone` — JS knows the timezone for free, Rust std does
/// not know it at all). Zero until set, which renders as `Z`: correct, just
/// not the user's clock. Captured once per app run, so a session that crosses
/// a DST switch drifts an hour until restart — accepted.
static TZ_OFFSET_MINUTES: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

pub fn set_tz_offset_minutes(minutes: i32) {
    // Clamp to the real-world range so a bogus caller cannot wrap timestamps
    // into other days.
    let clamped = minutes.clamp(-14 * 60, 14 * 60);
    TZ_OFFSET_MINUTES.store(clamped, std::sync::atomic::Ordering::Relaxed);
}

fn tz_offset_minutes() -> i32 {
    TZ_OFFSET_MINUTES.load(std::sync::atomic::Ordering::Relaxed)
}

/// `2026-07-30T22:12:00+02:00` from epoch-ms — the user's wall clock, with the
/// offset spelled out so the instant stays unambiguous (frontmatter is read by
/// humans in editors, not just by the parser). Offset zero keeps the `Z` form.
/// Second precision, matching the frontmatter examples in the spec — the
/// sub-second remainder is dropped, so re-projecting a parsed timestamp is
/// stable (truncation is idempotent).
pub fn iso_ms(ms: i64) -> String {
    iso_ms_with(ms, tz_offset_minutes())
}

/// Pure variant, unit-testable without touching the process-global offset.
pub fn iso_ms_with(ms: i64, offset_minutes: i32) -> String {
    let secs = ms.div_euclid(1000) + i64::from(offset_minutes) * 60;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mi, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, m, d) = civil_from_days(days);
    let base = format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mi:02}:{ss:02}");
    if offset_minutes == 0 {
        return format!("{base}Z");
    }
    let sign = if offset_minutes < 0 { '-' } else { '+' };
    let abs = offset_minutes.unsigned_abs();
    format!("{base}{sign}{:02}:{:02}", abs / 60, abs % 60)
}

/// Parse `YYYY-MM-DDTHH:MM:SS[.mmm][Z|±HH:MM]` back to epoch-ms. Tolerant of a
/// missing `Z` and of fractional seconds so hand-edited frontmatter still
/// imports; a `±HH:MM` offset (what `iso_ms` now writes for non-UTC users) is
/// applied, so local-clock timestamps round-trip to the same instant.
/// Anything else returns None and the caller falls back to `now_ms()`.
pub fn parse_iso(s: &str) -> Option<i64> {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if bytes[10] != b'T' && bytes[10] != b' ' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let y: i64 = s[0..4].parse().ok()?;
    let mo: i64 = s[5..7].parse().ok()?;
    let d: i64 = s[8..10].parse().ok()?;
    let hh: i64 = s[11..13].parse().ok()?;
    let mi: i64 = s[14..16].parse().ok()?;
    let ss: i64 = s[17..19].parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || hh > 23 || mi > 59 || ss > 60 {
        return None;
    }
    let mut ms = (days_from_civil(y, mo, d) * 86_400 + hh * 3600 + mi * 60 + ss) * 1000;
    // Optional `.mmm` fraction.
    let mut tail = 19;
    if bytes.len() > 19 && bytes[19] == b'.' {
        let frac: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).collect();
        if !frac.is_empty() {
            let digits = frac.len().min(3);
            if let Ok(v) = frac[..digits].parse::<i64>() {
                ms += v * 10_i64.pow(3 - digits as u32);
            }
        }
        tail = 20 + frac_len(&s[20..]);
    }
    // Optional `Z` or `±HH:MM` — a local-clock timestamp names an instant
    // OFFSET minutes east of UTC, so the offset is subtracted back out.
    if let Some(rest) = s.get(tail..) {
        let rest = rest.trim();
        if let Some(sign) = rest.chars().next().filter(|c| *c == '+' || *c == '-') {
            let hhmm = &rest[1..];
            if hhmm.len() >= 5 && hhmm.as_bytes()[2] == b':' {
                let oh: i64 = hhmm[0..2].parse().ok()?;
                let om: i64 = hhmm[3..5].parse().ok()?;
                let off = (oh * 60 + om) * (if sign == '-' { -1 } else { 1 });
                ms -= off * 60_000;
            }
        }
    }
    Some(ms)
}

fn frac_len(s: &str) -> usize {
    s.chars().take_while(|c| c.is_ascii_digit()).count()
}

/// Howard Hinnant's civil-from-days. Same algorithm debug_log.rs uses; kept
/// local so this module stays independent of the crate root.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// The inverse, so a parsed frontmatter date round-trips.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ---------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------

pub const ACTOR_USER: &str = "user";
pub const ACTOR_AGENT: &str = "agent";
pub const ACTOR_EXTERNAL: &str = "external";
pub const ACTOR_SYSTEM: &str = "system";

/// Who made a change. Constructed SERVER-SIDE in every path — UI commands are
/// always `user`, the watcher is always `external`, and the IPC layer builds it
/// from the hello envelope. Nothing a model can write ever reaches this type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    /// Serialized as `kind`: the plan fixes the actor shape as
    /// `{kind, agentKind?}` and the frontend's `KnowledgeActor` reads exactly
    /// that. The Rust name stays `actor_type` because `type` is a keyword and
    /// the column it comes from is `actor_type`.
    #[serde(rename = "kind")]
    pub actor_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

impl Actor {
    fn of(kind: &str) -> Self {
        Self {
            actor_type: kind.to_string(),
            agent_kind: None,
            session_id: None,
            pane_id: None,
        }
    }

    pub fn user() -> Self {
        Self::of(ACTOR_USER)
    }
    pub fn system() -> Self {
        Self::of(ACTOR_SYSTEM)
    }
    pub fn external() -> Self {
        Self::of(ACTOR_EXTERNAL)
    }

    pub fn agent(kind: &str, session_id: Option<String>, pane_id: Option<String>) -> Self {
        Self {
            actor_type: ACTOR_AGENT.to_string(),
            agent_kind: Some(kind.to_string()),
            session_id,
            pane_id,
        }
    }

    /// What lands in `notes.updated_by` — the CLI name when an agent wrote, so
    /// the sidebar can colour the row without a second lookup.
    pub fn byline(&self) -> String {
        if self.actor_type == ACTOR_AGENT {
            if let Some(k) = &self.agent_kind {
                return k.clone();
            }
        }
        self.actor_type.clone()
    }

    /// The exact inverse of `byline`. A byline that is not one of the four
    /// actor kinds is a CLI name, which is the only way an agent byline is ever
    /// written.
    pub fn from_byline(byline: &str) -> Self {
        match byline {
            ACTOR_USER | ACTOR_SYSTEM | ACTOR_EXTERNAL => Self::of(byline),
            "" => Self::of(ACTOR_SYSTEM),
            cli => Self::agent(cli, None, None),
        }
    }
}

/// Serialize a stored byline string as the `{kind, agentKind?}` object the plan
/// and the frontend both specify.
///
/// A `serialize_with` pair rather than a second struct field on purpose: the
/// byline string is the column, the actor object is a view of it, and two
/// fields holding the same fact is two fields that can disagree.
fn ser_byline_as_actor<S: serde::Serializer>(byline: &str, s: S) -> Result<S::Ok, S::Error> {
    Actor::from_byline(byline).serialize(s)
}

/// Accept either spelling coming back in: the object we now emit, or the bare
/// byline string older payloads and the DB round-trip use.
fn de_actor_as_byline<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Either {
        Text(String),
        Object(Actor),
    }
    Ok(match Either::deserialize(d)? {
        Either::Text(s) => s,
        Either::Object(a) => a.byline(),
    })
}

// ---------------------------------------------------------------------------
// Payload types (camelCase — these cross into JS and onto the IPC wire)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeStatus {
    /// One of the frontend's `KnowledgeStatus` values — `loading`,
    /// `uninitialized`, `ready`, `readonly`, `unavailable`,
    /// `remote-unsupported`. The vocabulary is shared deliberately: the sidebar
    /// routes a whole panel off this string, and a value it does not recognise
    /// falls back to `ready`, which would render a broken project as a working
    /// one.
    pub state: String,
    pub project_key: String,
    pub project_path: String,
    pub revision: i64,
    pub note_count: i64,
    /// `conflictCount` on the wire. (The change EVENT calls the same number
    /// `openConflicts` — that name is fixed by the plan's payload contract.)
    #[serde(rename = "conflictCount")]
    pub open_conflicts: i64,
    /// `policy` on the wire — `KnowledgeProjectStatus.policy`.
    #[serde(rename = "policy")]
    pub write_policy: String,
    /// Agent writes waiting on an approval under the `ask` policy.
    pub pending_approvals: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readonly_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl KnowledgeStatus {
    pub fn simple(state: &str, project_key: &str, project_path: &str) -> Self {
        Self {
            state: state.to_string(),
            project_key: project_key.to_string(),
            project_path: project_path.to_string(),
            revision: 0,
            note_count: 0,
            open_conflicts: 0,
            write_policy: super::store::POLICY_ASK.to_string(),
            pending_approvals: 0,
            memory_dir: None,
            readonly_reason: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub id: String,
    /// `type` on the wire — the frontend's `KnowledgeNoteMeta.type`, and the
    /// same word the frontmatter uses. `note_type` in Rust only because `type`
    /// is a keyword.
    #[serde(rename = "type")]
    pub note_type: String,
    pub title: String,
    pub slug: String,
    pub file_path: String,
    pub revision: i64,
    pub content_hash: String,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Stored as a byline string, published as `{kind, agentKind?}` so the
    /// sidebar can colour the attribution dot straight from the row.
    #[serde(
        serialize_with = "ser_byline_as_actor",
        deserialize_with = "de_actor_as_byline"
    )]
    pub created_by: String,
    #[serde(
        serialize_with = "ser_byline_as_actor",
        deserialize_with = "de_actor_as_byline"
    )]
    pub updated_by: String,
    pub archived: bool,
    pub pinned_core: bool,
    /// Set only when this note has an unresolved conflict, so a row can carry a
    /// marker. Filled in by the list/get commands, not by the store — a join on
    /// every internal read would cost more than the state is worth.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub meta: NoteMeta,
    pub content: String,
}

/// What every mutating call returns. `status` is the contract the UI and the
/// MCP adapter both branch on; `conflict` is populated only for "conflict".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    /// ok | merged | noop | conflict
    pub status: String,
    pub id: String,
    pub revision: i64,
    pub previous_revision: i64,
    pub file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<ConflictSummary>,
}

/// Everything a caller needs to rebase and retry without a second round trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSummary {
    pub id: String,
    pub current_revision: i64,
    pub current_content: String,
    pub current_updated_by: String,
    pub current_updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub id: String,
    pub entity_id: String,
    pub title: String,
    pub file_path: String,
    pub base_revision: i64,
    /// The head at the moment the conflict was RECORDED.
    pub current_revision: i64,
    /// The head right now. A caller passes this back to `resolve_conflict` so a
    /// resolution decided against a view that has since gone stale is refused
    /// instead of silently overwriting whoever moved the head.
    pub head_revision: i64,
    /// The losing write, preserved verbatim — `yours` in the modal's
    /// yours/current/merged view.
    #[serde(rename = "yours")]
    pub theirs_content: String,
    #[serde(rename = "current")]
    pub current_content: String,
    /// Who wrote the losing side.
    #[serde(rename = "yoursActor")]
    pub actor: Actor,
    /// Who holds the head it lost to.
    pub current_actor: Actor,
    /// api | file
    pub source: String,
    pub status: String,
    pub created_at: i64,
    /// The auto-merge, when one exists — lets the UI offer "Accept merged"
    /// without a second call, and disable it with a reason when it doesn't.
    #[serde(rename = "merged", skip_serializing_if = "Option::is_none")]
    pub merged_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionMeta {
    pub entity_id: String,
    pub revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<i64>,
    pub title: String,
    pub content_hash: String,
    pub actor: Actor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInfo {
    pub seq: i64,
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    pub actor: Actor,
    pub summary: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationInfo {
    pub id: String,
    pub source_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<String>,
    pub rel_type: String,
    pub origin: String,
    /// Resolved title of the other end, for rendering without a second lookup.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_title: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlinks {
    pub incoming: Vec<RelationInfo>,
    pub outgoing: Vec<RelationInfo>,
}

/// Everything an agent needs to pick up where another left off. The struct is
/// the record of truth; HANDOFFS.md carries a rendered copy for humans and for
/// agents reading the projection directly with MADE closed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handoff {
    pub id: String,
    /// The one-line summary, published as `title` too: the UI lists handoffs by
    /// title, and `task` is what the create input and the MCP tool call it.
    #[serde(rename = "title")]
    pub task: String,
    pub completed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_work: Option<String>,
    pub remaining: Vec<String>,
    pub files_changed: Vec<String>,
    pub decisions: Vec<String>,
    pub known_issues: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_action: Option<String>,
    pub status: String,
    #[serde(rename = "createdBy")]
    pub actor: Actor,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consumed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub consumed_by: Option<String>,
    /// The same handoff as the markdown section written into HANDOFFS.md — the
    /// UI pastes this straight into a terminal, so it never re-renders it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rendered_markdown: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffInput {
    pub task: String,
    #[serde(default)]
    pub completed: Vec<String>,
    #[serde(default)]
    pub current_work: Option<String>,
    #[serde(default)]
    pub remaining: Vec<String>,
    #[serde(default)]
    pub files_changed: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub known_issues: Vec<String>,
    #[serde(default)]
    pub next_action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// open | in-progress | done | archived
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    pub created_at: i64,
    pub created_by: String,
    pub updated_at: i64,
    pub updated_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    #[serde(rename = "entityId")]
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub note_type: String,
    pub file_path: String,
    pub snippet: String,
    pub updated_at: i64,
    #[serde(
        serialize_with = "ser_byline_as_actor",
        deserialize_with = "de_actor_as_byline"
    )]
    pub updated_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSource {
    pub entity_id: String,
    pub revision: i64,
    pub title: String,
    pub file_path: String,
    pub content: String,
    pub token_estimate: i64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPackage {
    #[serde(rename = "projectId")]
    pub project_key: String,
    pub generated_at: i64,
    pub knowledge_revision: i64,
    pub token_estimate: i64,
    /// True when the budget cut a source short, so the composer's ref strip can
    /// say the expansion is partial instead of implying it sent everything.
    pub truncated: bool,
    pub sources: Vec<ContextSource>,
    /// Unresolvable refs, echoed back so the composer can say so honestly
    /// instead of silently dropping them.
    pub missing: Vec<String>,
    pub rendered_prompt_context: String,
}

/// One live MCP adapter socket, for Settings' diagnostics block.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionInfo {
    pub id: u64,
    pub agent_kind: String,
    pub project_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub mode: String,
    pub connected_at: i64,
    pub last_seen_at: i64,
    pub call_count: i64,
    pub pid: i64,
    /// What the MCP client calls itself. Self-reported and therefore display-only
    /// — never used for attribution or authorization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_version: Option<String>,
}

/// A pending "an agent wants to write" approval, raised under the `ask` policy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub request_id: String,
    pub project_key: String,
    pub project_path: String,
    pub agent_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    pub method: String,
    pub created_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a64_matches_reference_vectors() {
        // The published FNV-1a-64 test vectors. If a refactor ever changes this
        // function, every persisted content_hash silently invalidates — these
        // pin the output shape as much as the algorithm.
        assert_eq!(fnv1a64(b""), "cbf29ce484222325");
        assert_eq!(fnv1a64(b"a"), "af63dc4c8601ec8c");
        assert_eq!(fnv1a64(b"foobar"), "85944171f73967e8");
        assert_eq!(hash_str("").len(), 16);
    }

    #[test]
    fn ids_are_prefixed_and_validated() {
        let id = new_id(ID_NOTE);
        assert!(id.starts_with("kn_"));
        assert!(is_valid_id(&id, ID_NOTE));
        assert!(!is_valid_id(&id, ID_TASK));
        assert!(!is_valid_id("kn_short", ID_NOTE));
        assert!(!is_valid_id("kn_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", ID_NOTE));
    }

    #[test]
    fn iso_round_trips_through_epoch_ms() {
        // 2026-07-30T20:12:00Z
        let ms = 1_785_442_320_000;
        assert_eq!(iso_ms(ms), "2026-07-30T20:12:00Z");
        assert_eq!(parse_iso("2026-07-30T20:12:00Z"), Some(ms));
        assert_eq!(parse_iso(&iso_ms(ms)), Some(ms));
        // Sub-second input truncates, and truncation is stable on re-render.
        assert_eq!(iso_ms(ms + 789), "2026-07-30T20:12:00Z");
        // Tolerant forms a human might leave behind.
        assert_eq!(parse_iso("2026-07-30T20:12:00"), Some(ms));
        assert_eq!(parse_iso("2026-07-30T20:12:00.500Z"), Some(ms + 500));
        assert_eq!(parse_iso("not a date"), None);
        assert_eq!(parse_iso("2026-13-30T20:12:00Z"), None);

        // Local-clock rendering: the SAME instant, spelled in the user's
        // offset, and the round trip lands on the same epoch-ms. Sweden in
        // summer (+120) and a negative half-hour zone both hold.
        assert_eq!(iso_ms_with(ms, 120), "2026-07-30T22:12:00+02:00");
        assert_eq!(parse_iso("2026-07-30T22:12:00+02:00"), Some(ms));
        assert_eq!(iso_ms_with(ms, -330), "2026-07-30T14:42:00-05:30");
        assert_eq!(parse_iso("2026-07-30T14:42:00-05:30"), Some(ms));
        assert_eq!(parse_iso(&iso_ms_with(ms, 120)), Some(ms));
        // A date pushed across midnight by the offset still round-trips.
        assert_eq!(parse_iso(&iso_ms_with(ms, 4 * 60)), Some(ms));
        // Fraction and offset together.
        assert_eq!(parse_iso("2026-07-30T22:12:00.500+02:00"), Some(ms + 500));
    }

    #[test]
    fn epoch_zero_and_leap_days() {
        assert_eq!(iso_ms(0), "1970-01-01T00:00:00Z");
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
        // 2024 was a leap year; Feb 29 must survive both directions.
        let leap = parse_iso("2024-02-29T12:00:00Z").expect("leap day parses");
        assert_eq!(iso_ms(leap), "2024-02-29T12:00:00Z");
    }

    #[test]
    fn actor_byline_prefers_agent_kind() {
        assert_eq!(Actor::user().byline(), "user");
        assert_eq!(Actor::external().byline(), "external");
        assert_eq!(Actor::agent("codex", None, None).byline(), "codex");
    }
}

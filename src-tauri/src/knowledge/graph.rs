//! The in-memory index: every note's metadata, plus the link structure.
//!
//! Content is NOT held here. The sidebar's hot paths — list, status, backlinks,
//! title resolution — are all metadata, and answering them from memory keeps
//! them off SQLite entirely. Bodies are fetched by primary key when something
//! actually needs one, which lands in the page cache anyway.
//!
//! The graph is rebuilt from SQLite on open and mutated in lockstep with each
//! commit, so it is a cache with exactly one writer and never a second source
//! of truth.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

use super::model::NoteMeta;
use super::projector::slugify;

/// A `[[Target#Heading|alias]]` occurrence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiLink {
    pub title: String,
    pub heading: Option<String>,
    pub alias: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RelationMeta {
    pub id: String,
    pub source_id: String,
    pub target_id: Option<String>,
    pub target_title: Option<String>,
    pub heading: Option<String>,
    pub rel_type: String,
    pub origin: String,
}

pub const REL_LINKS_TO: &str = "links-to";
pub const ORIGIN_WIKI: &str = "wiki";
pub const ORIGIN_EXPLICIT: &str = "explicit";

/// Case- and whitespace-insensitive title key. Titles are what humans type in
/// links; matching them literally would make `[[Auth Design]]` miss
/// `[[auth design]]` for no reason a user would accept.
pub fn fold_title(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut last_space = false;
    for ch in title.trim().chars() {
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.extend(ch.to_lowercase());
            last_space = false;
        }
    }
    out
}

#[derive(Default)]
pub struct Graph {
    pub entities: HashMap<String, NoteMeta>,
    by_title_folded: HashMap<String, String>,
    by_slug: HashMap<String, String>,
    pub relations: HashMap<String, RelationMeta>,
    outgoing: HashMap<String, Vec<String>>,
    incoming: HashMap<String, Vec<String>>,
    /// folded title -> relation ids still waiting for that note to exist
    unresolved: HashMap<String, Vec<String>>,
}

impl Graph {
    pub fn note(&self, id: &str) -> Option<&NoteMeta> {
        self.entities.get(id)
    }

    pub fn len(&self) -> usize {
        self.entities.len()
    }

    /// Notes in a stable order: core documents first in their canonical order,
    /// then everything else newest-first. The sidebar renders this directly.
    pub fn list(&self, include_archived: bool) -> Vec<NoteMeta> {
        let mut out: Vec<NoteMeta> = self
            .entities
            .values()
            .filter(|n| include_archived || !n.archived)
            .cloned()
            .collect();
        out.sort_by(|a, b| {
            b.pinned_core
                .cmp(&a.pinned_core)
                .then_with(|| {
                    if a.pinned_core {
                        a.file_path.cmp(&b.file_path)
                    } else {
                        b.updated_at.cmp(&a.updated_at)
                    }
                })
                .then_with(|| a.id.cmp(&b.id))
        });
        out
    }

    pub fn by_type(&self, note_type: &str) -> Option<&NoteMeta> {
        self.entities.values().find(|n| n.note_type == note_type)
    }

    pub fn by_file_path(&self, file_path: &str) -> Option<&NoteMeta> {
        let want = file_path.replace('\\', "/");
        self.entities.values().find(|n| n.file_path == want)
    }

    /// Title first, then slug — someone linking `[[auth-design]]` means the note
    /// whose file is `auth-design.md` even though its title reads "Auth Design".
    pub fn resolve_title(&self, title: &str) -> Option<String> {
        if let Some(id) = self.by_title_folded.get(&fold_title(title)) {
            return Some(id.clone());
        }
        self.by_slug.get(&slugify(title)).cloned()
    }

    pub fn upsert_note(&mut self, meta: NoteMeta) {
        if let Some(old) = self.entities.get(&meta.id) {
            let old_title = fold_title(&old.title);
            if old_title != fold_title(&meta.title) {
                if self.by_title_folded.get(&old_title) == Some(&meta.id) {
                    self.by_title_folded.remove(&old_title);
                }
            }
            if old.slug != meta.slug && self.by_slug.get(&old.slug) == Some(&meta.id) {
                self.by_slug.remove(&old.slug);
            }
        }
        self.by_title_folded
            .entry(fold_title(&meta.title))
            .or_insert_with(|| meta.id.clone());
        self.by_slug
            .entry(meta.slug.clone())
            .or_insert_with(|| meta.id.clone());
        self.entities.insert(meta.id.clone(), meta);
    }

    /// Relations that were waiting for this title, now that it exists. Returns
    /// the relation ids the caller must also UPDATE in SQLite — the maps and
    /// the rows have to move together or a reopen would undo the rebinding.
    pub fn rebind_unresolved(&mut self, title: &str, id: &str) -> Vec<String> {
        let key = fold_title(title);
        let Some(rel_ids) = self.unresolved.remove(&key) else {
            return Vec::new();
        };
        let mut rebound = Vec::new();
        for rel_id in rel_ids {
            let Some(rel) = self.relations.get_mut(&rel_id) else {
                continue;
            };
            rel.target_id = Some(id.to_string());
            self.incoming
                .entry(id.to_string())
                .or_default()
                .push(rel_id.clone());
            rebound.push(rel_id);
        }
        rebound
    }

    pub fn insert_relation(&mut self, rel: RelationMeta) {
        self.outgoing
            .entry(rel.source_id.clone())
            .or_default()
            .push(rel.id.clone());
        match (&rel.target_id, &rel.target_title) {
            (Some(target), _) => {
                self.incoming
                    .entry(target.clone())
                    .or_default()
                    .push(rel.id.clone());
            }
            (None, Some(title)) => {
                self.unresolved
                    .entry(fold_title(title))
                    .or_default()
                    .push(rel.id.clone());
            }
            (None, None) => {}
        }
        self.relations.insert(rel.id.clone(), rel);
    }

    pub fn remove_relation(&mut self, rel_id: &str) {
        let Some(rel) = self.relations.remove(rel_id) else {
            return;
        };
        if let Some(v) = self.outgoing.get_mut(&rel.source_id) {
            v.retain(|r| r != rel_id);
        }
        if let Some(target) = &rel.target_id {
            if let Some(v) = self.incoming.get_mut(target) {
                v.retain(|r| r != rel_id);
            }
        } else if let Some(title) = &rel.target_title {
            let key = fold_title(title);
            if let Some(v) = self.unresolved.get_mut(&key) {
                v.retain(|r| r != rel_id);
                if v.is_empty() {
                    self.unresolved.remove(&key);
                }
            }
        }
    }

    pub fn outgoing_of(&self, id: &str) -> Vec<&RelationMeta> {
        self.outgoing
            .get(id)
            .map(|ids| ids.iter().filter_map(|r| self.relations.get(r)).collect())
            .unwrap_or_default()
    }

    pub fn incoming_of(&self, id: &str) -> Vec<&RelationMeta> {
        self.incoming
            .get(id)
            .map(|ids| ids.iter().filter_map(|r| self.relations.get(r)).collect())
            .unwrap_or_default()
    }

    /// Wiki relations currently recorded for a source, so a commit can diff the
    /// freshly parsed set against them.
    pub fn wiki_relations_of(&self, source_id: &str) -> Vec<RelationMeta> {
        self.outgoing_of(source_id)
            .into_iter()
            .filter(|r| r.origin == ORIGIN_WIKI)
            .cloned()
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Wiki-link scanning
// ---------------------------------------------------------------------------

fn wiki_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\[\[([^\]\[#|]+)(?:#([^\]\[|]*))?(?:\|([^\]\[]*))?\]\]")
            .expect("wiki link regex is a literal")
    })
}

/// Every `[[link]]` in the document, ignoring anything inside a fenced block or
/// an inline code span.
///
/// The masking pass is the point: documentation about this very feature is full
/// of `[[Title]]` written as an example, and indexing those would fabricate
/// relations that no one wrote.
pub fn parse_wiki_links(content: &str) -> Vec<WikiLink> {
    let masked = mask_code(content);
    let mut out = Vec::new();
    for caps in wiki_re().captures_iter(&masked) {
        let title = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        if title.is_empty() {
            continue;
        }
        out.push(WikiLink {
            title: title.to_string(),
            heading: caps
                .get(2)
                .map(|m| m.as_str().trim().to_string())
                .filter(|s| !s.is_empty()),
            alias: caps
                .get(3)
                .map(|m| m.as_str().trim().to_string())
                .filter(|s| !s.is_empty()),
        });
    }
    out
}

/// Blank out fenced blocks and inline code spans, one space per character, so
/// the regex above only ever sees prose.
fn mask_code(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut in_fence = false;
    let mut fence_marker = ' ';
    let mut fence_len = 0usize;

    for (idx, line) in content.split('\n').enumerate() {
        if idx > 0 {
            out.push('\n');
        }
        let trimmed = line.trim_start();
        let opener = fence_run(trimmed);
        if let Some((marker, len)) = opener {
            if in_fence {
                // A closing fence must use the same marker and be at least as
                // long as the one that opened the block (CommonMark).
                if marker == fence_marker && len >= fence_len {
                    in_fence = false;
                }
            } else {
                in_fence = true;
                fence_marker = marker;
                fence_len = len;
            }
            blank_into(&mut out, line);
            continue;
        }
        if in_fence {
            blank_into(&mut out, line);
            continue;
        }
        mask_inline_code(&mut out, line);
    }
    out
}

/// `(marker, run length)` when a line opens or closes a fence.
fn fence_run(trimmed: &str) -> Option<(char, usize)> {
    let first = trimmed.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let len = trimmed.chars().take_while(|c| *c == first).count();
    if len >= 3 {
        Some((first, len))
    } else {
        None
    }
}

fn blank_into(out: &mut String, line: &str) {
    for _ in line.chars() {
        out.push(' ');
    }
}

fn mask_inline_code(out: &mut String, line: &str) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != '`' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let run = chars[i..].iter().take_while(|c| **c == '`').count();
        // Find a closing run of exactly the same length on this line.
        let mut j = i + run;
        let mut close = None;
        while j < chars.len() {
            if chars[j] == '`' {
                let r = chars[j..].iter().take_while(|c| **c == '`').count();
                if r == run {
                    close = Some(j);
                    break;
                }
                j += r;
            } else {
                j += 1;
            }
        }
        match close {
            Some(end) => {
                for _ in i..end + run {
                    out.push(' ');
                }
                i = end + run;
            }
            // Unbalanced backtick — literal text, not a code span.
            None => {
                for _ in 0..run {
                    out.push('`');
                }
                i += run;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wiki_link_parser_handles_every_form() {
        let src = "See [[Auth Design]] and [[Store#Schema]] plus [[Notes|the notes]].";
        let links = parse_wiki_links(src);
        assert_eq!(links.len(), 3);
        assert_eq!(links[0].title, "Auth Design");
        assert_eq!(links[0].heading, None);
        assert_eq!(links[1].title, "Store");
        assert_eq!(links[1].heading.as_deref(), Some("Schema"));
        assert_eq!(links[2].title, "Notes");
        assert_eq!(links[2].alias.as_deref(), Some("the notes"));
    }

    #[test]
    fn links_inside_code_are_ignored() {
        let src = "\
real [[Alpha]]

```md
fenced [[Beta]]
```

inline `[[Gamma]]` stays out

~~~
tilde [[Delta]]
~~~

trailing [[Epsilon]]";
        let titles: Vec<String> = parse_wiki_links(src).into_iter().map(|l| l.title).collect();
        assert_eq!(titles, vec!["Alpha".to_string(), "Epsilon".to_string()]);
    }

    #[test]
    fn unbalanced_backtick_does_not_swallow_the_rest() {
        let src = "a ` stray tick then [[Real]] link";
        let titles: Vec<String> = parse_wiki_links(src).into_iter().map(|l| l.title).collect();
        assert_eq!(titles, vec!["Real".to_string()]);
    }

    #[test]
    fn malformed_links_are_skipped() {
        assert!(parse_wiki_links("[[]] [[   ]] [not a link] [[unclosed").is_empty());
    }

    #[test]
    fn fold_title_is_case_and_whitespace_insensitive() {
        assert_eq!(fold_title("  Auth   Design "), "auth design");
        assert_eq!(fold_title("AUTH DESIGN"), fold_title("auth design"));
    }

    fn meta(id: &str, title: &str) -> NoteMeta {
        NoteMeta {
            id: id.to_string(),
            note_type: "note".into(),
            title: title.to_string(),
            slug: slugify(title),
            file_path: format!("notes/{}.md", slugify(title)),
            revision: 1,
            content_hash: "0".into(),
            tags: vec![],
            created_at: 0,
            updated_at: 0,
            created_by: "user".into(),
            updated_by: "user".into(),
            archived: false,
            pinned_core: false,
            conflict_id: None,
        }
    }

    #[test]
    fn backlinks_and_unresolved_rebinding() {
        let mut g = Graph::default();
        g.upsert_note(meta("kn_a", "Alpha"));
        // Alpha links to a note nobody has written yet.
        g.insert_relation(RelationMeta {
            id: "rel_1".into(),
            source_id: "kn_a".into(),
            target_id: None,
            target_title: Some("Beta".into()),
            heading: None,
            rel_type: REL_LINKS_TO.into(),
            origin: ORIGIN_WIKI.into(),
        });
        assert!(g.incoming_of("kn_b").is_empty());
        assert_eq!(g.outgoing_of("kn_a").len(), 1);

        // Creating Beta rebinds the dangling link.
        g.upsert_note(meta("kn_b", "Beta"));
        let rebound = g.rebind_unresolved("Beta", "kn_b");
        assert_eq!(rebound, vec!["rel_1".to_string()]);
        assert_eq!(g.incoming_of("kn_b").len(), 1);
        assert_eq!(
            g.relations.get("rel_1").and_then(|r| r.target_id.clone()),
            Some("kn_b".to_string())
        );

        // Dropping the link cleans both directions.
        g.remove_relation("rel_1");
        assert!(g.incoming_of("kn_b").is_empty());
        assert!(g.outgoing_of("kn_a").is_empty());
    }

    #[test]
    fn resolve_title_falls_back_to_slug() {
        let mut g = Graph::default();
        g.upsert_note(meta("kn_a", "Auth Design"));
        assert_eq!(g.resolve_title("auth design"), Some("kn_a".into()));
        assert_eq!(g.resolve_title("auth-design"), Some("kn_a".into()));
        assert_eq!(g.resolve_title("nothing"), None);
    }

    #[test]
    fn renaming_moves_the_title_key() {
        let mut g = Graph::default();
        // A slug unrelated to either title, so this tests the TITLE map and is
        // not quietly answered by the slug fallback.
        let mut original = meta("kn_a", "Old Name");
        original.slug = "n1".into();
        g.upsert_note(original);
        assert_eq!(g.resolve_title("Old Name"), Some("kn_a".into()));

        let mut renamed = meta("kn_a", "New Name");
        renamed.slug = "n1".into(); // slugs are stable across renames
        g.upsert_note(renamed);
        assert_eq!(g.resolve_title("New Name"), Some("kn_a".into()));
        assert_eq!(g.resolve_title("Old Name"), None);
        // The file name still resolves, which is the point of the fallback.
        assert_eq!(g.resolve_title("n1"), Some("kn_a".into()));
    }

    #[test]
    fn core_notes_sort_first() {
        let mut g = Graph::default();
        let mut core = meta("kn_core", "State");
        core.pinned_core = true;
        core.file_path = "STATE.md".into();
        g.upsert_note(core);
        g.upsert_note(meta("kn_x", "Zeta"));
        let listed = g.list(false);
        assert_eq!(listed[0].id, "kn_core");
    }
}

//! Render-time link detection for the always-on link underline.
//!
//! Ports the TWO JS matchers 1:1 (keep in sync — same divergence rule as the
//! triplicated mouse helpers):
//!  - URL_RE            (src/native-term/useNativeFileLinks.ts), incl. its
//!                      trailing-punctuation trim,
//!  - FILE_PATH_RE      (src/lib/file-link-provider.ts). Its negative
//!                      lookbehind `(?<![a-zA-Z]://)` is unsupported by the
//!                      `regex` crate and is emulated post-match.
//!
//! Used by `grid.rs::snapshot_rows` to force the underline attr on link
//! cells so links are visually spottable at ALL times (user decision
//! 2026-07-24), not only on hover. Hover/click behavior is unchanged
//! (useNativeFileLinks + the WM_LBUTTONDOWN Ctrl paths).

use regex::Regex;
use std::sync::OnceLock;

const EXTENSIONS: &str = "ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|sass|less|html|htm|xml|svg|\
py|pyi|rb|go|rs|c|h|cpp|hpp|cc|java|kt|swift|sh|bash|zsh|fish|\
yaml|yml|toml|ini|cfg|conf|env|lock|log|txt|csv|sql|graphql|gql|\
vue|svelte|astro|prisma|dockerfile|makefile|cmake";

fn url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)https?://[^\s<>"'`)\]}]+"#).expect("URL_RE parse")
    })
}

fn file_path_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let pattern = format!(
            r"(?i)((?:\.{{0,2}}/|[a-zA-Z0-9@_-]+/)(?:[a-zA-Z0-9._@/$-]+/)*[a-zA-Z0-9._@$-]+\.(?:{EXTENSIONS}))(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))?"
        );
        Regex::new(&pattern).expect("FILE_PATH_RE parse")
    })
}

/// Byte ranges (start, end-exclusive) of every link-looking span in `text`.
/// Unsorted; ranges from the two matchers may overlap (harmless for a
/// boolean underline mask).
pub fn link_byte_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    for m in url_re().find_iter(text) {
        // Trailing-punctuation trim (JS: raw.replace(/[.,;:!?]+$/, "")).
        let mut end = m.end();
        while end > m.start()
            && matches!(text.as_bytes()[end - 1], b'.' | b',' | b';' | b':' | b'!' | b'?')
        {
            end -= 1;
        }
        if end > m.start() {
            out.push((m.start(), end));
        }
    }
    let url_count = out.len();
    for m in file_path_re().find_iter(text) {
        // The JS lookbehind `(?<![a-zA-Z]://)` only rejects the exact
        // host-start position; slash-led sub-matches INSIDE a URL still
        // fire there and are simply absorbed by the URL's own underline.
        // Emulate with cleaner semantics for a boolean mask: skip any file
        // match that starts inside one of the URL ranges above.
        let s = m.start();
        if out[..url_count].iter().any(|&(us, ue)| s >= us && s < ue) {
            continue;
        }
        out.push((s, m.end()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hits(text: &str) -> Vec<&str> {
        link_byte_ranges(text)
            .into_iter()
            .map(|(s, e)| &text[s..e])
            .collect()
    }

    #[test]
    fn urls_and_trim() {
        assert_eq!(
            hits("see https://example.com/a?b=1, ok"),
            vec!["https://example.com/a?b=1"]
        );
    }

    #[test]
    fn file_paths() {
        assert_eq!(hits("in src/lib/foo.ts:12:3 fix"), vec!["src/lib/foo.ts:12:3"]);
        assert_eq!(hits("open ./docs/notes.md now"), vec!["./docs/notes.md"]);
    }

    #[test]
    fn no_scheme_tail_double_match() {
        // The URL matcher owns the whole thing; the file matcher must not
        // re-match the host/path tail.
        let h = hits("go https://github.com/openai/codex.ts done");
        assert_eq!(h, vec!["https://github.com/openai/codex.ts"]);
    }
}

//! Conservative three-way merge over lines.
//!
//! The dominant multi-agent pattern is two agents editing DIFFERENT sections of
//! the same document — one appends to STATE.md's "Current work" while another
//! rewrites its header. Failing those into a conflict every time would make the
//! store feel broken, so we splice them when we can prove they do not touch.
//!
//! "Prove" is the operative word. This merge is deliberately timid: it changes
//! nothing it is unsure about, and every uncertain case degrades to `None`,
//! which the caller turns into a conflict record with both sides preserved. It
//! is never the difference between keeping and losing work — only between a
//! silent success and a resolution prompt. That asymmetry is why the padding
//! below is generous and why the size cap bails out instead of guessing.

/// Kill switch. Flip to `false` to degrade to conflict-always without touching
/// a single call site — there for the case where a late merge bug is worse than
/// the resolution prompts it was avoiding.
const MERGE_ENABLED: bool = true;

/// Refuse the LCS table past this many cells. Notes are small; a pathological
/// input (a generated file, a pasted log) is not worth an O(n·m) allocation,
/// and a conflict record is a correct answer.
const MAX_LCS_CELLS: usize = 4_000_000;

/// How many unchanged lines must separate two edits before they count as
/// independent. One line of quiet on each side is cheap insurance against
/// "merged" output where two edits abut and produce nonsense.
const CONTEXT_PAD: usize = 1;

/// A replacement of `base[start..end]` with `lines`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Hunk {
    start: usize,
    end: usize,
    lines: Vec<String>,
}

/// `Some(merged)` when both sides' edits are provably independent, `None` when
/// they might interact — the caller records a conflict for the `None` case.
pub fn try_three_way_merge(base: &str, ours: &str, theirs: &str) -> Option<String> {
    if !MERGE_ENABLED {
        return None;
    }
    if ours == theirs {
        return Some(ours.to_string());
    }
    if base == ours {
        return Some(theirs.to_string());
    }
    if base == theirs {
        return Some(ours.to_string());
    }

    let base_lines: Vec<&str> = base.split('\n').collect();
    let our_hunks = diff_hunks(&base_lines, &ours.split('\n').collect::<Vec<_>>())?;
    let their_hunks = diff_hunks(&base_lines, &theirs.split('\n').collect::<Vec<_>>())?;

    let mut merged: Vec<Hunk> = our_hunks.clone();
    for t in &their_hunks {
        let mut collides = false;
        for o in &our_hunks {
            if !guards_overlap(o, t) {
                continue;
            }
            // The same edit arriving from both sides is not a conflict, it is a
            // duplicate — keep the copy already in the list and move on.
            if o == t {
                collides = true;
                break;
            }
            return None;
        }
        if !collides {
            merged.push(t.clone());
        }
    }

    merged.sort_by_key(|h| (h.start, h.end));
    Some(splice(&base_lines, &merged))
}

/// Do two hunks sit close enough that applying both could interleave? Compared
/// with `CONTEXT_PAD` lines of slack, and treating a pure insertion (start ==
/// end) as occupying its insertion point so two inserts at the same seam
/// collide.
fn guards_overlap(a: &Hunk, b: &Hunk) -> bool {
    let a_start = a.start.saturating_sub(CONTEXT_PAD);
    let a_end = a.end + CONTEXT_PAD;
    let b_start = b.start.saturating_sub(CONTEXT_PAD);
    let b_end = b.end + CONTEXT_PAD;
    a_start < b_end && b_start < a_end
}

fn splice(base: &[&str], hunks: &[Hunk]) -> String {
    let mut out: Vec<String> = Vec::with_capacity(base.len());
    let mut cursor = 0usize;
    for h in hunks {
        while cursor < h.start && cursor < base.len() {
            out.push(base[cursor].to_string());
            cursor += 1;
        }
        out.extend(h.lines.iter().cloned());
        cursor = cursor.max(h.end);
    }
    while cursor < base.len() {
        out.push(base[cursor].to_string());
        cursor += 1;
    }
    out.join("\n")
}

/// Changed regions of `side` relative to `base`, in BASE coordinates.
///
/// Common prefix and suffix are trimmed before the LCS so the usual shapes
/// (append at the end, edit at the top) never build a table at all.
fn diff_hunks(base: &[&str], side: &[&str]) -> Option<Vec<Hunk>> {
    let mut prefix = 0usize;
    while prefix < base.len() && prefix < side.len() && base[prefix] == side[prefix] {
        prefix += 1;
    }
    let mut suffix = 0usize;
    while suffix < base.len() - prefix
        && suffix < side.len() - prefix
        && base[base.len() - 1 - suffix] == side[side.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let a = &base[prefix..base.len() - suffix];
    let b = &side[prefix..side.len() - suffix];
    if a.is_empty() && b.is_empty() {
        return Some(Vec::new());
    }
    if a.is_empty() || b.is_empty() {
        // A pure insertion or a pure deletion — no LCS needed.
        let mut hunks = vec![Hunk {
            start: prefix,
            end: prefix + a.len(),
            lines: b.iter().map(|s| s.to_string()).collect(),
        }];
        canonicalize(base, &mut hunks);
        return Some(hunks);
    }
    if a.len().saturating_mul(b.len()) > MAX_LCS_CELLS {
        return None;
    }

    let matches = lcs_matches(a, b);
    let mut hunks = Vec::new();
    let (mut ai, mut bi) = (0usize, 0usize);
    for (ma, mb) in matches.iter().copied().chain(std::iter::once((a.len(), b.len()))) {
        if ma > ai || mb > bi {
            hunks.push(Hunk {
                start: prefix + ai,
                end: prefix + ma,
                lines: b[bi..mb].iter().map(|s| s.to_string()).collect(),
            });
        }
        ai = ma + 1;
        bi = mb + 1;
    }
    canonicalize(base, &mut hunks);
    Some(hunks)
}

/// Slide position-ambiguous hunks to their LAST equivalent position.
///
/// The prefix/suffix trims above are greedy from opposite ends, so the SAME
/// logical edit can be attributed different base coordinates depending on what
/// else the side changed. With `base = A B X Y` and both sides appending a
/// second `X Y`, the side that also edited line 0 cannot trim a prefix, so its
/// suffix trim eats the appended copy and reports the insertion two lines
/// earlier than the side that trimmed the whole prefix. The two hunks then look
/// independent (the shift exceeds `CONTEXT_PAD`), both apply, and the block
/// lands in the output THREE times — a silent corruption committed as "merged".
///
/// An insertion whose first line repeats the base line it sits before produces
/// byte-identical output one line further down, so there is a free choice; the
/// same holds for a deletion whose window is followed by an identical line.
/// Picking the last such position on BOTH sides is what makes the duplicate
/// collapse at `o == t` and makes genuinely different edits land on one seam and
/// trip the overlap guard. Sliding never changes what a side alone produces —
/// only where the merge believes the edit happened.
fn canonicalize(base: &[&str], hunks: &mut [Hunk]) {
    for i in 0..hunks.len() {
        // Never slide into the next hunk: they must stay disjoint and ordered
        // for `splice` to reproduce the side faithfully.
        let limit = hunks.get(i + 1).map(|h| h.start).unwrap_or(base.len());
        let h = &mut hunks[i];
        if h.start == h.end && !h.lines.is_empty() {
            // Pure insertion. Rotating keeps the spliced text identical.
            while h.end < limit && base[h.end] == h.lines[0] {
                h.lines.rotate_left(1);
                h.start += 1;
                h.end += 1;
            }
        } else if h.lines.is_empty() && h.end > h.start {
            // Pure deletion of a run that repeats immediately after itself.
            while h.end < limit && base[h.start] == base[h.end] {
                h.start += 1;
                h.end += 1;
            }
        }
    }
}

/// Index pairs of the longest common subsequence, ascending.
fn lcs_matches(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
    let (n, m) = (a.len(), b.len());
    let mut table = vec![0u32; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[at(i, j)] = if a[i] == b[j] {
                table[at(i + 1, j + 1)] + 1
            } else {
                table[at(i + 1, j)].max(table[at(i, j + 1)])
            };
        }
    }
    let mut out = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            out.push((i, j));
            i += 1;
            j += 1;
        } else if table[at(i + 1, j)] >= table[at(i, j + 1)] {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(lines: &[&str]) -> String {
        lines.join("\n")
    }

    #[test]
    fn disjoint_regions_merge() {
        let base = doc(&["# Title", "", "alpha", "", "beta", "", "gamma"]);
        let ours = doc(&["# Title", "", "ALPHA", "", "beta", "", "gamma"]);
        let theirs = doc(&["# Title", "", "alpha", "", "beta", "", "GAMMA"]);
        let merged = try_three_way_merge(&base, &ours, &theirs).expect("far-apart edits merge");
        assert!(merged.contains("ALPHA"));
        assert!(merged.contains("GAMMA"));
        assert!(merged.contains("beta"));
    }

    #[test]
    fn overlapping_edit_returns_none() {
        let base = doc(&["one", "two", "three"]);
        let ours = doc(&["one", "TWO-ours", "three"]);
        let theirs = doc(&["one", "TWO-theirs", "three"]);
        assert_eq!(try_three_way_merge(&base, &ours, &theirs), None);
    }

    #[test]
    fn adjacent_edits_are_treated_as_overlapping() {
        // Only one quiet line between them: the padding must refuse this rather
        // than emit plausible-looking nonsense.
        let base = doc(&["a", "b", "c", "d"]);
        let ours = doc(&["a", "B", "c", "d"]);
        let theirs = doc(&["a", "b", "C", "d"]);
        assert_eq!(try_three_way_merge(&base, &ours, &theirs), None);
    }

    #[test]
    fn identical_changes_collapse() {
        let base = doc(&["one", "two", "three"]);
        let same = doc(&["one", "TWO", "three"]);
        assert_eq!(
            try_three_way_merge(&base, &same, &same),
            Some(same.clone())
        );
        // Same edit, arrived independently, plus a far-away edit on one side.
        let base = doc(&["h", "", "one", "", "x", "", "y", "", "tail"]);
        let ours = doc(&["h", "", "ONE", "", "x", "", "y", "", "tail"]);
        let theirs = doc(&["h", "", "ONE", "", "x", "", "y", "", "TAIL"]);
        let merged = try_three_way_merge(&base, &ours, &theirs).expect("dup + disjoint merges");
        assert_eq!(merged.matches("ONE").count(), 1);
        assert!(merged.contains("TAIL"));
    }

    #[test]
    fn append_at_end_vs_edit_at_top_merges() {
        // The reason this component exists: two agents writing to different
        // parts of STATE.md.
        let base = doc(&["# State", "", "## Now", "idle", "", "## Notes", "none"]);
        let ours = doc(&["# State (v2)", "", "## Now", "idle", "", "## Notes", "none"]);
        let theirs = doc(&[
            "# State", "", "## Now", "idle", "", "## Notes", "none", "", "## Added", "by codex",
        ]);
        let merged = try_three_way_merge(&base, &ours, &theirs).expect("top vs bottom merges");
        assert!(merged.starts_with("# State (v2)"));
        assert!(merged.ends_with("by codex"));
    }

    #[test]
    fn both_appending_at_the_end_conflicts() {
        // Two appends land on the same seam. There is no way to know the
        // intended order, so this must NOT merge.
        let base = doc(&["# Log", "", "- first"]);
        let ours = doc(&["# Log", "", "- first", "- ours"]);
        let theirs = doc(&["# Log", "", "- first", "- theirs"]);
        assert_eq!(try_three_way_merge(&base, &ours, &theirs), None);
    }

    #[test]
    fn one_sided_edits_short_circuit() {
        let base = doc(&["a", "b"]);
        let ours = doc(&["a", "B"]);
        assert_eq!(
            try_three_way_merge(&base, &ours, &base),
            Some(ours.clone())
        );
        assert_eq!(try_three_way_merge(&base, &base, &ours), Some(ours));
    }

    #[test]
    fn deletion_far_from_an_insertion_merges() {
        let base = doc(&["k0", "k1", "drop-me", "k3", "k4", "k5", "k6", "k7"]);
        let ours = doc(&["k0", "k1", "k3", "k4", "k5", "k6", "k7"]);
        let theirs = doc(&["k0", "k1", "drop-me", "k3", "k4", "k5", "k6", "k7", "added"]);
        let merged = try_three_way_merge(&base, &ours, &theirs).expect("delete + append merges");
        assert!(!merged.contains("drop-me"));
        assert!(merged.contains("added"));
    }

    #[test]
    fn trailing_newline_survives() {
        let base = "alpha\n\nbeta\n\ngamma\n";
        let ours = "ALPHA\n\nbeta\n\ngamma\n";
        let theirs = "alpha\n\nbeta\n\nGAMMA\n";
        let merged = try_three_way_merge(base, ours, theirs).expect("merges");
        assert!(merged.ends_with('\n'), "trailing newline dropped: {merged:?}");
        assert!(merged.starts_with("ALPHA"));
    }

    #[test]
    fn empty_base_with_two_writers_conflicts() {
        assert_eq!(try_three_way_merge("", "ours", "theirs"), None);
    }

    /// A repeated trailing block must never be tripled.
    ///
    /// The exact reproduction from the 2026-08-07 red-team pass: both sides
    /// appended the same `X Y`, but one of them also edited line 0, which
    /// stopped its prefix trim and made its suffix trim attribute the append
    /// two lines earlier. The duplicate went unrecognised and both insertions
    /// applied. Either answer is acceptable — the merge collapsing the
    /// duplicate, or refusing — but a third copy is corruption.
    #[test]
    fn repeated_trailing_block_is_not_tripled() {
        let base = doc(&["A", "B", "X", "Y"]);
        let ours = doc(&["A", "B", "X", "Y", "X", "Y"]);
        let theirs = doc(&["a2", "B", "X", "Y", "X", "Y"]);
        assert_eq!(
            try_three_way_merge(&base, &ours, &theirs),
            Some(doc(&["a2", "B", "X", "Y", "X", "Y"])),
            "the identical append must collapse; the X/Y block appears twice on \
             both sides and must appear twice in the result"
        );
    }

    /// The same class with the shape it actually takes in a memory doc: a
    /// blank line plus a `---` separator repeated at the tail.
    #[test]
    fn repeated_two_line_separator_block_is_not_duplicated() {
        let base = doc(&["# Log", "", "---", "entry one", "", "---"]);
        let ours = doc(&["# Log", "", "---", "entry one", "", "---", "", "---"]);
        let theirs = doc(&["# Log v2", "", "---", "entry one", "", "---", "", "---"]);
        let merged = try_three_way_merge(&base, &ours, &theirs);
        if let Some(m) = merged {
            assert_eq!(
                m.matches("---").count(),
                3,
                "both sides hold three separators; merged must not invent a fourth: {m:?}"
            );
            assert!(m.starts_with("# Log v2"));
        }
    }

    /// Sliding must not turn genuinely different edits into a silent merge —
    /// once both land on the same seam the overlap guard has to fire.
    #[test]
    fn sliding_still_conflicts_when_the_appends_differ() {
        let base = doc(&["A", "B", "X", "Y"]);
        let ours = doc(&["A", "B", "X", "Y", "X", "Y"]);
        let theirs = doc(&["a2", "B", "X", "Y", "OURS-ONLY"]);
        assert_eq!(
            try_three_way_merge(&base, &ours, &theirs),
            None,
            "two different tail edits must conflict, not splice"
        );
    }

    /// A deletion of one copy of a repeated run is position-ambiguous the same
    /// way an insertion is; both sides deleting it must collapse, not delete
    /// twice.
    #[test]
    fn repeated_run_deleted_by_both_sides_collapses() {
        let base = doc(&["k0", "dup", "dup", "k3", "k4", "k5", "k6"]);
        let ours = doc(&["k0", "dup", "k3", "k4", "k5", "k6"]);
        let theirs = doc(&["k0", "dup", "k3", "k4", "k5", "K6"]);
        if let Some(m) = try_three_way_merge(&base, &ours, &theirs) {
            assert_eq!(
                m.matches("dup").count(),
                1,
                "one copy was deleted by each side; exactly one must survive: {m:?}"
            );
        }
    }
}

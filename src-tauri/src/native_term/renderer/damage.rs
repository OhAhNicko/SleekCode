// Row-level dirty-bit tracking for the cell-grid renderer.
//
// alacritty_terminal exposes its own per-line damage via `term.damage()` but
// the iterator covers only ranges, and the grid lookup costs a mutex. We keep
// a separate bitset here so the worker thread can mark rows quickly without
// pulling alacritty's full damage state into the renderer.
//
// Backing: a single Vec<u64>. mark_row/clear are O(1), dirty_rows is O(rows/64).
// Resize zeros and re-sizes; we re-mark everything on grid resize anyway.

/// Per-row dirty tracker. One bit per row, packed 64 rows per u64.
pub struct DamageTracker {
    rows: usize,
    bits: Vec<u64>,
}

impl DamageTracker {
    pub fn new(rows: usize) -> Self {
        let words = rows.div_ceil(64);
        Self { rows, bits: vec![0u64; words] }
    }

    /// Resize to `rows` rows. All rows marked dirty so the next render
    /// repaints everything — necessary because resize changes the cell grid
    /// dimensions, invalidating any prior layout.
    pub fn resize(&mut self, rows: usize) {
        let words = rows.div_ceil(64);
        self.bits = vec![u64::MAX; words];
        self.rows = rows;
    }

    /// Mark a single row as dirty. Silently no-op for out-of-range indices.
    pub fn mark_row(&mut self, row: usize) {
        if row >= self.rows {
            return;
        }
        let word = row / 64;
        let bit = row % 64;
        self.bits[word] |= 1u64 << bit;
    }

    /// Mark every row dirty. Used on theme/font swap and surface lost recovery.
    pub fn mark_all(&mut self) {
        for w in self.bits.iter_mut() {
            *w = u64::MAX;
        }
    }

    /// Clear all dirty bits. Called by the renderer after a frame is drawn.
    pub fn clear(&mut self) {
        for w in self.bits.iter_mut() {
            *w = 0;
        }
    }

    /// True if any row is dirty. Cheap; used to skip the wgpu pass entirely
    /// during idle frames.
    pub fn any_dirty(&self) -> bool {
        self.bits.iter().any(|&w| w != 0)
    }

    /// Iterator over dirty row indices in ascending order.
    pub fn dirty_rows(&self) -> impl Iterator<Item = usize> + '_ {
        self.bits.iter().enumerate().flat_map(move |(word_idx, &word)| {
            let base = word_idx * 64;
            (0..64).filter_map(move |bit| {
                if word & (1u64 << bit) != 0 {
                    Some(base + bit).filter(|&r| r < self.rows)
                } else {
                    None
                }
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_and_iter() {
        let mut d = DamageTracker::new(100);
        d.mark_row(3);
        d.mark_row(64); // word boundary
        d.mark_row(99); // last valid
        d.mark_row(200); // out of range — no-op
        let dirty: Vec<usize> = d.dirty_rows().collect();
        assert_eq!(dirty, vec![3, 64, 99]);
    }

    #[test]
    fn resize_marks_all() {
        let mut d = DamageTracker::new(10);
        d.clear();
        assert!(!d.any_dirty());
        d.resize(20);
        assert!(d.any_dirty());
        let dirty: Vec<usize> = d.dirty_rows().collect();
        assert_eq!(dirty.len(), 20);
    }

    #[test]
    fn clear_idempotent() {
        let mut d = DamageTracker::new(50);
        d.mark_row(10);
        d.mark_row(20);
        assert!(d.any_dirty());
        d.clear();
        assert!(!d.any_dirty());
        d.clear();
        assert!(!d.any_dirty());
    }
}

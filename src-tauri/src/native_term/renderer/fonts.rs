// Process-wide cosmic-text `FontSystem`, shared by every native pane.
//
// WHY: measured per pane (`[native_term] glyph_atlas` lines in the dlog),
// `FontSystem::new()` cost **60-76ms** — roughly two thirds of the pane's
// glyph/atlas time — because it enumerates and parses every font installed on
// the machine. That work is identical for every pane and produces identical
// results, so doing it once is a straight ~65ms saving per pane with nothing
// given up.
//
// The alternative considered and REJECTED was trimming the font set to the
// embedded Hack faces (`new_with_fonts`), which is faster still but drops the
// system fallback that renders anything Hack lacks: CJK, emoji, and the very
// symbols in Claude Code's spinner row. That trades a visible tofu-glyph
// regression for ~30ms more. Sharing gets the same win without the trade.
//
// THREADING: `FontSystem` is not `Sync`, so it lives behind a `Mutex`. In
// practice this is uncontended — every pane's wnd_proc, and therefore all
// shaping, runs on the one UI thread. The lock exists to satisfy the type
// system and to stay correct if that ever changes.
//
// RE-ENTRANCY: `std::sync::Mutex` is NOT reentrant. Never call a method that
// locks (e.g. `GlyphStack::make_buffer`) while already holding the guard — take
// the guard once and pass `&mut *guard` down. `CellGrid::sync_from_term` does
// exactly that for its row-shaping loop.

use std::sync::{Arc, Mutex, OnceLock};

use glyphon::FontSystem;

/// Embedded Hack faces — the pane's primary family. Registered into the shared
/// db once, alongside the system fonts.
const HACK_REGULAR: &[u8] = include_bytes!("../../../assets/fonts/Hack-Regular.ttf");
const HACK_BOLD: &[u8] = include_bytes!("../../../assets/fonts/Hack-Bold.ttf");
const HACK_ITALIC: &[u8] = include_bytes!("../../../assets/fonts/Hack-Italic.ttf");
const HACK_BOLD_ITALIC: &[u8] = include_bytes!("../../../assets/fonts/Hack-BoldItalic.ttf");

static FONTS: OnceLock<Arc<Mutex<FontSystem>>> = OnceLock::new();

/// The shared `FontSystem`, built on first use.
pub fn shared() -> Arc<Mutex<FontSystem>> {
    FONTS.get_or_init(|| Arc::new(Mutex::new(build()))).clone()
}

/// Build the shared `FontSystem` off the critical path (called from
/// `gpu::prewarm`'s thread at app start), so the first pane does not pay the
/// system-font parse.
pub fn prewarm() {
    let _ = shared();
}

fn build() -> FontSystem {
    let t0 = std::time::Instant::now();
    let mut font_system = FontSystem::new();
    let t_system = t0.elapsed();

    // P5b: register the embedded Hack faces so shaping and measurement resolve
    // the family we actually draw with. fontdb parses each blob and indexes the
    // contained face; per-glyph fallback for missing coverage (CJK, emoji) is
    // cosmic-text's job, served by the system fonts loaded above.
    {
        let db = font_system.db_mut();
        db.load_font_data(HACK_REGULAR.to_vec());
        db.load_font_data(HACK_BOLD.to_vec());
        db.load_font_data(HACK_ITALIC.to_vec());
        db.load_font_data(HACK_BOLD_ITALIC.to_vec());
    }

    // A system-installed Hack can push this above 4; below 4 means the embedded
    // blobs failed to parse and the family bug is back.
    let hack_faces = font_system
        .db()
        .faces()
        .filter(|face| face.families.iter().any(|(name, _)| name == "Hack"))
        .count();

    let line = format!(
        "[native_term] fonts: shared FontSystem built {:.1}ms (system {:.1} + embed {:.1}), {hack_faces} 'Hack' faces (expect >=4)",
        t0.elapsed().as_secs_f32() * 1000.0,
        t_system.as_secs_f32() * 1000.0,
        (t0.elapsed() - t_system).as_secs_f32() * 1000.0,
    );
    eprintln!("{line}");
    crate::debug_log::dlog(&line);

    font_system
}

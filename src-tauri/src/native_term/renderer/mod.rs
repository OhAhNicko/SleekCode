pub mod cursor;
pub mod damage;
pub mod glyph_atlas;
pub mod grid;
pub mod pipeline;
pub mod quad_pipeline;

pub use pipeline::Renderer;

/// Per-renderer mutable theme state. Replaces the previous hardcoded
/// `ANSI_PALETTE` + `bg_clear` + cursor color literals. Each color is RGBA in
/// 0..=255 byte space; the renderer divides by 255 when handing colors to
/// wgpu / glyphon. Stored on `Renderer` and shared with `CellGrid` via
/// `Arc<RwLock<ThemeColors>>` so snapshot lookups during shaping can read the
/// current palette without re-passing it through every call site.
#[derive(Clone, Copy, Debug)]
pub struct ThemeColors {
    /// 16-slot ANSI palette: indices 0..7 are normal black/red/.../white,
    /// 8..15 are the bright variants. Matches alacritty's `Color::Indexed(i)`
    /// for `i < 16` and `NamedColor::Black..=BrightWhite`.
    pub ansi: [[u8; 4]; 16],
    pub foreground: [u8; 4],
    pub background: [u8; 4],
    pub cursor: [u8; 4],
    pub cursor_accent: [u8; 4],
    pub selection: [u8; 4],
}

impl ThemeColors {
    /// Tango-ish defaults — exactly the previous `ANSI_PALETTE` + matching
    /// fg/bg/cursor/selection used before `set_theme` was wired through.
    /// Used as the initial palette before the JS side calls `set_theme`.
    pub fn default_tango() -> Self {
        ThemeColors {
            ansi: [
                [0x00, 0x00, 0x00, 0xFF], // Black
                [0xCC, 0x00, 0x00, 0xFF], // Red
                [0x4E, 0x9A, 0x06, 0xFF], // Green
                [0xC4, 0xA0, 0x00, 0xFF], // Yellow
                [0x34, 0x65, 0xA4, 0xFF], // Blue
                [0x75, 0x50, 0x7B, 0xFF], // Magenta
                [0x06, 0x98, 0x9A, 0xFF], // Cyan
                [0xD3, 0xD7, 0xCF, 0xFF], // White
                [0x55, 0x57, 0x53, 0xFF], // BrightBlack
                [0xEF, 0x29, 0x29, 0xFF], // BrightRed
                [0x8A, 0xE2, 0x34, 0xFF], // BrightGreen
                [0xFC, 0xE9, 0x4F, 0xFF], // BrightYellow
                [0x72, 0x9F, 0xCF, 0xFF], // BrightBlue
                [0xAD, 0x7F, 0xA8, 0xFF], // BrightMagenta
                [0x34, 0xE2, 0xE2, 0xFF], // BrightCyan
                [0xEE, 0xEE, 0xEC, 0xFF], // BrightWhite
            ],
            foreground: [0xD3, 0xD7, 0xCF, 0xFF],
            background: [0x0D, 0x0D, 0x11, 0xFF],
            cursor: [0xDB, 0xD6, 0xCF, 0xCC],
            cursor_accent: [0x0D, 0x0D, 0x11, 0xFF],
            selection: [0x44, 0x55, 0x6B, 0xFF],
        }
    }
}

// Shared theme-color parsing for the platform window backends.
//
// `set_theme` arrives from JS with hex-string colors. Every platform (win32,
// macOS, Linux) folds it the same way into `ThemeColors` for the renderer.
// Originally each `window/<platform>.rs` carried its own private copy; this
// module is the consolidation. Behavior is byte-identical to the three
// previous duplicates.

use super::renderer::ThemeColors;
use super::window::TerminalTheme;

/// Parse a `#RRGGBB` or `#RRGGBBAA` hex string into a 4-byte RGBA color.
/// Missing alpha defaults to 0xFF (fully opaque). The `field` argument is
/// used only in the error message so the JS side can pinpoint which theme
/// key was malformed; we return `Result<[u8;4], String>` rather than
/// panicking because the wire format originates from JS and shouldn't be
/// able to crash the process if a user installs a hand-edited theme file.
pub fn parse_hex_color(s: &str, field: &str) -> Result<[u8; 4], String> {
    let bytes = s.strip_prefix('#').unwrap_or(s);
    if bytes.len() != 6 && bytes.len() != 8 {
        return Err(format!(
            "native_term::set_theme: field `{field}` must be #RRGGBB or #RRGGBBAA (got `{s}`)"
        ));
    }
    let parse = |i: usize| -> Result<u8, String> {
        u8::from_str_radix(&bytes[i..i + 2], 16)
            .map_err(|_| format!("native_term::set_theme: field `{field}` is not valid hex"))
    };
    let r = parse(0)?;
    let g = parse(2)?;
    let b = parse(4)?;
    let a = if bytes.len() == 8 { parse(6)? } else { 0xFF };
    Ok([r, g, b, a])
}

/// Fold a wire-format `TerminalTheme` (hex strings) into a `ThemeColors` the
/// renderer can consume directly. Order of fields mirrors `ThemeColors`.
pub fn parse_theme(theme: &TerminalTheme) -> Result<ThemeColors, String> {
    let ansi = [
        parse_hex_color(&theme.ansi0, "ansi0")?,
        parse_hex_color(&theme.ansi1, "ansi1")?,
        parse_hex_color(&theme.ansi2, "ansi2")?,
        parse_hex_color(&theme.ansi3, "ansi3")?,
        parse_hex_color(&theme.ansi4, "ansi4")?,
        parse_hex_color(&theme.ansi5, "ansi5")?,
        parse_hex_color(&theme.ansi6, "ansi6")?,
        parse_hex_color(&theme.ansi7, "ansi7")?,
        parse_hex_color(&theme.ansi8, "ansi8")?,
        parse_hex_color(&theme.ansi9, "ansi9")?,
        parse_hex_color(&theme.ansi10, "ansi10")?,
        parse_hex_color(&theme.ansi11, "ansi11")?,
        parse_hex_color(&theme.ansi12, "ansi12")?,
        parse_hex_color(&theme.ansi13, "ansi13")?,
        parse_hex_color(&theme.ansi14, "ansi14")?,
        parse_hex_color(&theme.ansi15, "ansi15")?,
    ];
    Ok(ThemeColors {
        ansi,
        foreground: parse_hex_color(&theme.foreground, "foreground")?,
        background: parse_hex_color(&theme.background, "background")?,
        cursor: parse_hex_color(&theme.cursor, "cursor")?,
        cursor_accent: parse_hex_color(&theme.cursor_accent, "cursorAccent")?,
        selection: parse_hex_color(&theme.selection, "selection")?,
    })
}

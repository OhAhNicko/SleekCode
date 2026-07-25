// Keyboard encoding for the native terminal pane: Win32 virtual-key +
// modifier state -> the byte sequence a terminal expects.
//
// Lives outside window/win32.rs (and outside any #[cfg(windows)] gate) so it
// is a pure, unit-testable table. win32.rs's wndproc is the only caller.

/// What a non-character keydown should do. Mirrors xterm.js's
/// `KeyboardResultType` (SEND_KEY / PAGE_UP / PAGE_DOWN).
pub enum KeyAction {
    /// Byte sequence to write to the PTY.
    Bytes(Vec<u8>),
    /// Scroll the viewport instead of reaching the PTY (Shift+PgUp/PgDn).
    ScrollPageUp,
    ScrollPageDown,
}

/// True for virtual keys that TranslateMessage ALSO turns into a WM_CHAR /
/// WM_SYSCHAR. The message loop runs TranslateMessage BEFORE DispatchMessage,
/// so by the time this wndproc consumes the WM_KEYDOWN the char is already
/// queued and `LRESULT(0)` cannot un-queue it. When WM_KEYDOWN forwards its
/// own byte sequence for one of these, it MUST arm `swallow_next_char` or the
/// PTY receives the key twice — that was the "backspace deletes two
/// characters" bug (Backspace/Tab/Enter/Escape were all doubled).
pub fn vk_also_yields_char(vk: u32) -> bool {
    matches!(vk, 0x08 /* Back */ | 0x09 /* Tab */ | 0x0D /* Return */ | 0x1B /* Esc */)
}

/// Translate a Win32 virtual-key + modifier state into the byte sequence a
/// terminal expects. Returns `None` for keys that should fall through to
/// WM_CHAR (printable characters, and Ctrl+letter combos, which Windows
/// composes into control codes itself).
///
/// Direct port of xterm.js's `evaluateKeyboardEvent`
/// (`node_modules/@xterm/xterm/src/common/input/Keyboard.ts`) with
/// `isMac = false`, so native panes emit byte-for-byte what xterm panes emit —
/// the xterm/native parity rule. Modifier bits use xterm's encoding
/// (shift=1, alt=2, ctrl=4) and the emitted CSI parameter is `modifiers + 1`.
///
/// Modifiers used to be dropped entirely here (the fn took only `vk`), so
/// Shift+Tab sent a bare HT and never triggered the Claude Code mode cycle,
/// and Ctrl/Alt+arrow never moved by word.
pub fn vk_to_key_action(
    vk: u32,
    ctrl: bool,
    shift: bool,
    alt: bool,
    app_cursor: bool,
) -> Option<KeyAction> {
    // Constants from windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY.
    // Using raw u32 values avoids importing the whole VK_* module.
    const VK_BACK: u32 = 0x08;
    const VK_TAB: u32 = 0x09;
    const VK_RETURN: u32 = 0x0D;
    const VK_ESCAPE: u32 = 0x1B;
    const VK_PRIOR: u32 = 0x21; // PgUp
    const VK_NEXT: u32 = 0x22; // PgDn
    const VK_END: u32 = 0x23;
    const VK_HOME: u32 = 0x24;
    const VK_LEFT: u32 = 0x25;
    const VK_UP: u32 = 0x26;
    const VK_RIGHT: u32 = 0x27;
    const VK_DOWN: u32 = 0x28;
    const VK_INSERT: u32 = 0x2D;
    const VK_DELETE: u32 = 0x2E;

    fn seq(s: String) -> Option<KeyAction> {
        Some(KeyAction::Bytes(s.into_bytes()))
    }

    let modifiers = (shift as u8) | ((alt as u8) << 1) | ((ctrl as u8) << 2);
    let m = modifiers + 1; // the CSI parameter xterm.js emits

    // Arrows and Home/End share a shape: CSI 1 ; m <final> when modified,
    // SS3 <final> under DECCKM, plain CSI <final> otherwise. `alt_as_ctrl`
    // is xterm.js's non-Mac HACK (Keyboard.ts:120-124, 158-163) that remaps
    // Alt+arrow to Ctrl+arrow so it moves by word; it applies to arrows only.
    let cursor_key = |final_ch: char, alt_as_ctrl: bool| -> Option<KeyAction> {
        if modifiers != 0 {
            let p = if alt_as_ctrl && m == 3 { 5 } else { m };
            seq(format!("\x1b[1;{p}{final_ch}"))
        } else if app_cursor {
            seq(format!("\x1bO{final_ch}"))
        } else {
            seq(format!("\x1b[{final_ch}"))
        }
    };
    // Tilde-form keys: CSI <n> ~ , or CSI <n> ; m ~ when modified.
    let tilde_key = |n: u32| -> Option<KeyAction> {
        if modifiers != 0 {
            seq(format!("\x1b[{n};{m}~"))
        } else {
            seq(format!("\x1b[{n}~"))
        }
    };
    // F1-F4: SS3 form unmodified, CSI 1 ; m <final> when modified.
    let ss3_fn_key = |final_ch: char| -> Option<KeyAction> {
        if modifiers != 0 {
            seq(format!("\x1b[1;{m}{final_ch}"))
        } else {
            seq(format!("\x1bO{final_ch}"))
        }
    };

    match vk {
        // Most terminals expect DEL (0x7F) for Backspace, not BS (0x08);
        // Ctrl+Backspace inverts that to ^H and Alt prefixes ESC, which is
        // what readline reads as delete-word-backward.
        VK_BACK => {
            let mut b = vec![if ctrl { 0x08 } else { 0x7F }];
            if alt {
                b.insert(0, 0x1b);
            }
            Some(KeyAction::Bytes(b))
        }
        // Shift+Tab => CSI Z (back-tab). This is the Claude Code mode cycle.
        VK_TAB => {
            if shift {
                seq("\x1b[Z".to_string())
            } else {
                Some(KeyAction::Bytes(vec![b'\t']))
            }
        }
        // NOTE: Shift+Enter is deliberately NOT special-cased here. It sends a
        // bare CR like any other terminal, because this table is shared by
        // EVERY native pane (shell, codex, gemini, Claude's non-fullscreen
        // mode) and those must keep stock behaviour. The Claude-fullscreen
        // "Shift+Enter inserts a newline" binding lives in win32.rs's
        // WM_KEYDOWN arm, gated on the pane opting in.
        VK_RETURN => Some(KeyAction::Bytes(if alt {
            vec![0x1b, b'\r']
        } else {
            vec![b'\r']
        })),
        VK_ESCAPE => Some(KeyAction::Bytes(if alt {
            vec![0x1b, 0x1b]
        } else {
            vec![0x1b]
        })),
        VK_UP => cursor_key('A', true),
        VK_DOWN => cursor_key('B', true),
        VK_RIGHT => cursor_key('C', true),
        VK_LEFT => cursor_key('D', true),
        VK_HOME => cursor_key('H', false),
        VK_END => cursor_key('F', false),
        // Ctrl/Shift+Insert are copy/paste on many systems (Shift+Insert is
        // consumed as paste earlier), so only the bare key forwards.
        VK_INSERT => {
            if !shift && !ctrl {
                tilde_key(2)
            } else {
                None
            }
        }
        VK_DELETE => tilde_key(3),
        // PgUp/PgDn take modifiers ONLY from Ctrl (xterm.js cases 33/34):
        // Shift scrolls the viewport, Alt alone sends the bare sequence.
        VK_PRIOR => {
            if shift {
                Some(KeyAction::ScrollPageUp)
            } else if ctrl {
                seq(format!("\x1b[5;{m}~"))
            } else {
                seq("\x1b[5~".to_string())
            }
        }
        VK_NEXT => {
            if shift {
                Some(KeyAction::ScrollPageDown)
            } else if ctrl {
                seq(format!("\x1b[6;{m}~"))
            } else {
                seq("\x1b[6~".to_string())
            }
        }
        0x70 /* VK_F1 */ => ss3_fn_key('P'),
        0x71 /* VK_F2 */ => ss3_fn_key('Q'),
        0x72 /* VK_F3 */ => ss3_fn_key('R'),
        0x73 /* VK_F4 */ => ss3_fn_key('S'),
        0x74 /* VK_F5 */ => tilde_key(15),
        0x75 /* VK_F6 */ => tilde_key(17),
        0x76 /* VK_F7 */ => tilde_key(18),
        0x77 /* VK_F8 */ => tilde_key(19),
        0x78 /* VK_F9 */ => tilde_key(20),
        0x79 /* VK_F10 */ => tilde_key(21),
        0x7A /* VK_F11 */ => tilde_key(23),
        0x7B /* VK_F12 */ => tilde_key(24),
        _ => None,
    }
}

#[cfg(test)]
mod key_encoding_tests {
    use super::*;

    /// Assert `vk_to_key_action` emits exactly these bytes.
    fn bytes(vk: u32, ctrl: bool, shift: bool, alt: bool, app_cursor: bool) -> Vec<u8> {
        match vk_to_key_action(vk, ctrl, shift, alt, app_cursor) {
            Some(KeyAction::Bytes(b)) => b,
            other => panic!(
                "expected Bytes for vk={vk:#04x} ctrl={ctrl} shift={shift} alt={alt}, got {}",
                match other {
                    Some(KeyAction::ScrollPageUp) => "ScrollPageUp",
                    Some(KeyAction::ScrollPageDown) => "ScrollPageDown",
                    None => "None",
                    _ => unreachable!(),
                }
            ),
        }
    }

    const BACK: u32 = 0x08;
    const TAB: u32 = 0x09;
    const RET: u32 = 0x0D;
    const ESC: u32 = 0x1B;
    const PRIOR: u32 = 0x21;
    const NEXT: u32 = 0x22;
    const END: u32 = 0x23;
    const HOME: u32 = 0x24;
    const LEFT: u32 = 0x25;
    const UP: u32 = 0x26;
    const DEL: u32 = 0x2E;

    /// The regression this whole change exists for: Shift+Tab must be CSI Z
    /// (back-tab), which is the Claude Code mode cycle. It used to send a
    /// bare HT because modifiers were dropped.
    #[test]
    fn shift_tab_is_back_tab() {
        assert_eq!(bytes(TAB, false, true, false, false), b"\x1b[Z");
        assert_eq!(bytes(TAB, false, false, false, false), b"\t");
    }

    /// xterm.js Keyboard.ts case 8.
    #[test]
    fn backspace_variants() {
        assert_eq!(bytes(BACK, false, false, false, false), b"\x7f");
        assert_eq!(bytes(BACK, true, false, false, false), b"\x08");
        assert_eq!(bytes(BACK, false, false, true, false), b"\x1b\x7f");
        assert_eq!(bytes(BACK, true, false, true, false), b"\x1b\x08");
    }

    #[test]
    fn enter_and_escape_take_alt_prefix() {
        assert_eq!(bytes(RET, false, false, false, false), b"\r");
        assert_eq!(bytes(RET, false, false, true, false), b"\x1b\r");
        assert_eq!(bytes(ESC, false, false, false, false), b"\x1b");
        assert_eq!(bytes(ESC, false, false, true, false), b"\x1b\x1b");
    }

    /// Shift+Enter must stay a BARE CR in this shared table. The Claude
    /// fullscreen "insert a newline" behaviour (ESC CR) is applied in win32.rs
    /// and gated per-pane, so shell / codex / gemini / Claude-normal panes keep
    /// stock terminal behaviour.
    #[test]
    fn shift_enter_stays_bare_cr_here() {
        assert_eq!(bytes(RET, false, true, false, false), b"\r");
        assert_eq!(bytes(RET, false, false, false, false), b"\r");
        // Alt+Enter is the standard ESC-prefixed form and is unaffected.
        assert_eq!(bytes(RET, false, false, true, false), b"\x1b\r");
    }

    /// Modifier param is `1 + shift|alt<<1|ctrl<<2`, matching xterm.js.
    #[test]
    fn arrows_encode_modifiers() {
        assert_eq!(bytes(UP, false, false, false, false), b"\x1b[A");
        assert_eq!(bytes(UP, false, true, false, false), b"\x1b[1;2A"); // shift
        assert_eq!(bytes(UP, true, false, false, false), b"\x1b[1;5A"); // ctrl
        assert_eq!(bytes(UP, true, true, false, false), b"\x1b[1;6A"); // ctrl+shift
    }

    /// xterm.js's non-Mac HACK: Alt+arrow is remapped to Ctrl+arrow so it
    /// moves by word. Applies to arrows ONLY, never Home/End.
    #[test]
    fn alt_arrow_remaps_to_ctrl_arrow() {
        assert_eq!(bytes(LEFT, false, false, true, false), b"\x1b[1;5D");
        assert_eq!(bytes(UP, false, false, true, false), b"\x1b[1;5A");
        // Home keeps the literal alt param (3), no remap.
        assert_eq!(bytes(HOME, false, false, true, false), b"\x1b[1;3H");
    }

    /// DECCKM switches unmodified cursor keys to SS3; modified keys ignore it.
    #[test]
    fn application_cursor_mode_uses_ss3() {
        assert_eq!(bytes(UP, false, false, false, true), b"\x1bOA");
        assert_eq!(bytes(HOME, false, false, false, true), b"\x1bOH");
        assert_eq!(bytes(END, false, false, false, true), b"\x1bOF");
        assert_eq!(bytes(UP, true, false, false, true), b"\x1b[1;5A");
    }

    #[test]
    fn delete_is_tilde_form() {
        assert_eq!(bytes(DEL, false, false, false, false), b"\x1b[3~");
        assert_eq!(bytes(DEL, true, false, false, false), b"\x1b[3;5~");
    }

    /// Keyboard.ts cases 33/34: Shift scrolls the viewport, Ctrl modifies the
    /// sequence, and Alt ALONE still sends the bare form.
    #[test]
    fn page_keys_only_take_ctrl_as_a_modifier() {
        assert!(matches!(
            vk_to_key_action(PRIOR, false, true, false, false),
            Some(KeyAction::ScrollPageUp)
        ));
        assert!(matches!(
            vk_to_key_action(NEXT, false, true, false, false),
            Some(KeyAction::ScrollPageDown)
        ));
        assert_eq!(bytes(PRIOR, true, false, false, false), b"\x1b[5;5~");
        assert_eq!(bytes(PRIOR, false, false, true, false), b"\x1b[5~");
        assert_eq!(bytes(NEXT, false, false, false, false), b"\x1b[6~");
    }

    #[test]
    fn f_keys_split_ss3_and_tilde_forms() {
        assert_eq!(bytes(0x70, false, false, false, false), b"\x1bOP"); // F1
        assert_eq!(bytes(0x70, false, true, false, false), b"\x1b[1;2P");
        assert_eq!(bytes(0x74, false, false, false, false), b"\x1b[15~"); // F5
        assert_eq!(bytes(0x7B, false, false, false, false), b"\x1b[24~"); // F12
    }

    /// Printable keys and Ctrl+letter fall through to WM_CHAR.
    #[test]
    fn printable_keys_fall_through() {
        assert!(vk_to_key_action(0x41, false, false, false, false).is_none()); // 'A'
        assert!(vk_to_key_action(0x41, true, false, false, false).is_none()); // Ctrl+A
    }

    /// Exactly the keys TranslateMessage also turns into a WM_CHAR. Getting
    /// this set wrong is the double-character bug in either direction.
    #[test]
    fn char_yielding_vks_are_latched() {
        for vk in [BACK, TAB, RET, ESC] {
            assert!(vk_also_yields_char(vk), "vk {vk:#04x} must arm the latch");
        }
        for vk in [LEFT, UP, HOME, END, DEL, PRIOR, NEXT, 0x70] {
            assert!(!vk_also_yields_char(vk), "vk {vk:#04x} must NOT arm the latch");
        }
    }
}

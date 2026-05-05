// Master kill-switch for the voice agent (push-to-talk + intent → action).
// Flip to `true` to re-enable. When false: no mic button, no HUD, no hotkey,
// no Settings section, no command-palette entry. The underlying code still
// compiles so the flag can be flipped without other edits.
export const VOICE_ENABLED = false;

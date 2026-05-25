// NO-OP — kept as an empty export for any existing mounts in App.tsx.
//
// Pre-2026-05-24 design: this coordinator hid every live native HWND when any
// modal opened and re-showed on close. User feedback rejected hiding entirely
// — terminal content should never disappear, even when a modal/palette opens.
// Replaced by per-pane hole-cutting via `useNativePaneRegion` (slice-sourced),
// mounted inside TerminalPaneNative. Popups publish their viewport rect via
// `useOverlayPublisher`; each pane independently intersects against its own
// bounding rect and emits pane-local holes via `native_term_set_region`.
//
// Left as a no-op export so App.tsx's `<NativePaneVisibilityCoordinator />`
// mount stays valid until the next cleanup pass.
export function NativePaneVisibilityCoordinator(): null {
  return null;
}

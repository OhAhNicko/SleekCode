# xterm.js File Path Link Provider

## Summary
Implemented Warp-style file path detection in terminal output using xterm.js `registerLinkProvider()` API. File paths are underlined on hover with a tooltip showing "Open in EzyDev [Ctrl+Click]", and Ctrl+Click opens the file in the existing FileViewerPane.

## Approach Chosen
Used `Terminal.registerLinkProvider()` with a custom `ILinkProvider` rather than extending `WebLinksAddon`:
- **WebLinksAddon** validates URLs via `new URL()` which rejects file paths
- **WebLinksAddon** doesn't expose `hover()`/`leave()` callbacks needed for custom tooltips
- `registerLinkProvider()` gives full control over `ILink` objects: `activate`, `hover`, `leave`, `decorations`

## Key Implementation Details

### Regex Design
- Two path styles: absolute (`/home/...`) and relative (`src/...`, `./...`, `../...`)
- Negative lookbehind `(?<![a-zA-Z]://)` prevents matching URLs (already handled by WebLinksAddon)
- Known file extensions whitelist reduces false positives (no bare `error.message` matches)
- Supports `:line:col` and `(line,col)` suffixes for TypeScript/compiler output

### Tooltip Positioning
- Tooltip is plain DOM (`document.createElement`) — not React — because lifecycle is tied to xterm's `hover()`/`leave()` callbacks
- Uses `position: fixed` with mouse coordinates, clamped to the terminal container's bounding rect
- Has CSS class `xterm-hover` which is xterm's official class that prevents link dismissal when mouse enters the tooltip element

### Wrapped Lines
- `getLineText()` follows `isWrapped` flag to concatenate continuation lines, matching how WebLinksAddon internals work

## Gotcha: ILink.activate receives text but regex match is pre-computed
The `activate(event, text)` callback receives the matched text, but we need the parsed `filePath`, `line`, and `col` from the regex. Solution: capture these in the closure when creating each `ILink` in `provideLinks()`, ignore the `text` parameter (prefix with `_`).

## Gotcha: Link range coordinates are 1-based
xterm's `IBufferRange` uses 1-based x/y coordinates. The regex match's `startIndex` is 0-based, so `x = startIndex + 1`.

## Prevention
- When using `registerLinkProvider`, always check whether the addon you're considering (WebLinksAddon, etc.) exposes the callbacks you need before trying to extend it
- File path regexes in terminal output need a whitelist of extensions to avoid false positives — bare word.word patterns are too common in shell output

## Verification
- `npx tsc --noEmit` — clean
- `npm run build` — passes
- Run `grep -rn "import" src/components/TerminalPane.tsx` in a terminal pane, hover file paths to see tooltip, Ctrl+Click to open

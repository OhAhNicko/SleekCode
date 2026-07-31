/** Strip terminal control sequences so regex matching sees plain text. */
export function cleanOutput(s: string): string {
  return s
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "") // DCS (e.g. Warp version reply)
    .replace(/\x1b\][\s\S]*?(\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[@-Z\\-_]/g, "") // other single-char escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""); // stray control chars (keep \t \n \r)
}

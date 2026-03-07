import type { TerminalType } from "../types";

/** Regex patterns that match the "resume" hint each CLI prints on exit. */
const RESUME_PATTERNS: Partial<Record<TerminalType, RegExp>> = {
  claude:
    /claude\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
};

/** Whether a terminal type supports session resume. */
export function supportsSessionResume(type: TerminalType): boolean {
  return type in RESUME_PATTERNS;
}

/** Strip ANSI escape sequences from text (SGR, cursor, etc.). */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Extract a session resume ID from terminal output text. Returns undefined if not found. */
export function extractSessionResumeId(
  text: string,
  type: TerminalType
): string | undefined {
  const pattern = RESUME_PATTERNS[type];
  if (!pattern) return undefined;
  const clean = stripAnsi(text);
  const match = clean.match(pattern);
  return match?.[1];
}

/** Build the CLI flag string for resuming a session. */
export function getResumeFlag(
  type: TerminalType,
  id: string
): string {
  switch (type) {
    case "claude":
      return `--resume ${id}`;
    default:
      return `--resume ${id}`;
  }
}

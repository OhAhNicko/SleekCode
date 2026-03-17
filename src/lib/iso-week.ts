/** Compute ISO 8601 week string from a timestamp, e.g. "2026-W12" */
export function isoWeekKey(timestamp: number): string {
  const d = new Date(timestamp);
  // ISO week: week starts Monday. Jan 4 is always in week 1.
  const dayOfWeek = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // nearest Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** Get the current ISO week key, e.g. "2026-W12" */
export function currentIsoWeek(): string {
  return isoWeekKey(Date.now());
}

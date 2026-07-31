/**
 * Jira ticket helpers.
 *
 * Deliberately pure and dependency-free — no React, no store, no Tauri — so the
 * rules that decide what counts as a ticket, where it lives and what Claude is
 * asked can be reasoned about (and unit-tested) without booting the app.
 */

/** `SUPPORT-24920`, `AB-1`, `PLATFORM_X-77`. Project key, dash, number. */
const TICKET_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

/** Same shape, but findable inside a longer string (a pasted browse URL). */
const TICKET_IN_TEXT_RE = /[A-Za-z][A-Za-z0-9_]*-\d+/;

/**
 * Accepts what a person actually has on their clipboard: a bare key in any
 * case, or a full ticket URL. Returns the canonical upper-case key, or null if
 * there is no ticket in there at all.
 *
 * A URL is matched on its LAST path-ish segment rather than anywhere in the
 * string, so a host that happens to contain a dash-number pair can't win over
 * the real key.
 */
export function normalizeTicketKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const direct = trimmed.toUpperCase();
  if (TICKET_RE.test(direct)) return direct;

  // Pasted URL — https://x.atlassian.net/browse/SUPPORT-24920?focusedId=1
  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const candidate = decodeURIComponent(segments[i]).toUpperCase();
      if (TICKET_RE.test(candidate)) return candidate;
    }
    // Some Jira views carry the key in a query param instead of the path.
    for (const value of url.searchParams.values()) {
      const candidate = value.toUpperCase();
      if (TICKET_RE.test(candidate)) return candidate;
    }
    return null;
  } catch {
    // Not a URL. Fall through to a loose scan so "ticket SUPPORT-24920" works.
  }

  const loose = trimmed.match(TICKET_IN_TEXT_RE);
  if (loose) {
    const candidate = loose[0].toUpperCase();
    if (TICKET_RE.test(candidate)) return candidate;
  }
  return null;
}

/** True for a string that is already a canonical key. */
export function isTicketKey(value: string): boolean {
  return TICKET_RE.test(value);
}

/**
 * `<base>/browse/<KEY>` — the canonical ticket permalink on both Jira Cloud and
 * self-hosted Data Center. Returns null when no base URL is configured yet, so
 * callers must decide what to do rather than navigating somewhere wrong.
 */
export function buildTicketUrl(baseUrl: string, ticket: string): string | null {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) return null;
  const withScheme = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  return `${withScheme}/browse/${ticket}`;
}

/**
 * Pull the site origin out of a URL that looks like Jira, for the base-URL
 * auto-discovery in the browser pane. Returns null for anything we are not
 * confident about — a wrong guess here silently sends every later ticket to the
 * wrong host, which is worse than asking once.
 */
export function jiraOriginFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    const looksLikeCloud = host.endsWith(".atlassian.net");
    const looksLikeTicketPath = /\/browse\/[A-Za-z][A-Za-z0-9_]*-\d+/.test(url.pathname);
    if (!looksLikeCloud && !looksLikeTicketPath) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Accept what people actually type for "Jira address": a bare company slug
 * ("acme"), a bare host ("acme.atlassian.net"), or a full URL. Returns a
 * canonical https base. A slug (no dot, no scheme, no slash) becomes
 * `https://<slug>.atlassian.net`; anything else keeps its host and just gains
 * a scheme if missing — self-hosted Jira keeps working with full addresses.
 */
export function normalizeJiraBaseUrl(raw: string): string {
  const t = raw.trim().replace(/\/+$/, "");
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (!t.includes(".") && !t.includes("/")) return `https://${t.toLowerCase()}.atlassian.net`;
  return `https://${t}`;
}

export const DEFAULT_JIRA_PROMPT =
  "Investigate ticket {ticket} using the Atlassian/Jira plugin and do a thorough " +
  "investigation. Only give short and concise, straight to the point info on the " +
  "issue and how to fix it.";

/** Appended per reply-language toggle. No toggle = template untouched. */
const SWEDISH_CLAUSE = "Answer in Swedish.";
const ENGLISH_CLAUSE = "Answer in English.";

/**
 * Fill the user's template. `{ticket}` is the only placeholder; a template that
 * forgets it still gets the key, appended, rather than sending Claude off to
 * investigate nothing.
 */
export function buildJiraPrompt(
  template: string,
  ticket: string,
  language?: "sv" | "en",
): string {
  const base = template.trim() || DEFAULT_JIRA_PROMPT;
  let filled = base.includes("{ticket}")
    ? base.split("{ticket}").join(ticket)
    : `${base} ${ticket}`;
  if (language === "sv") filled = `${filled} ${SWEDISH_CLAUSE}`;
  else if (language === "en") filled = `${filled} ${ENGLISH_CLAUSE}`;
  return filled.trim();
}

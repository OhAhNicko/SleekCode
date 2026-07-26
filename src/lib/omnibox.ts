// Address-bar input resolution — Chrome's omnibox behaviour.
//
// Typing `jira atlassian` should search; typing `google.se` should navigate. The
// old code prefixed a scheme onto whatever you typed, so a search term became
// `https://jira atlassian` and simply failed.
//
// Chrome's real implementation (AutocompleteInput::Parse) consults the Public
// Suffix List and the user's history. We approximate with the rules that matter
// in practice, in priority order:
//
//   1. An explicit scheme  -> URL, verbatim.
//   2. Any whitespace      -> search (a URL cannot contain a raw space).
//   3. localhost / IP / an explicit numeric port -> URL.
//   4. A dot with a plausible TLD label -> URL.
//   5. Anything else       -> search.

/** Where a bare search term goes. Chrome uses the default engine; we use Google
 *  and let it localise, which is what google.com does anyway. */
const SEARCH_ENDPOINT = "https://www.google.com/search?q=";

/** Last labels that read as a filename rather than a host. Without this,
 *  `notes.txt` or `bundle.js` would be treated as a domain and navigated to,
 *  which is never what someone typing into an address bar meant. Chrome gets
 *  this from the Public Suffix List; this is the short pragmatic version. */
const FILE_LIKE_SUFFIXES = new Set([
  "txt", "md", "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "ico",
  "js", "ts", "tsx", "jsx", "json", "yml", "yaml", "toml", "lock",
  "css", "scss", "html", "xml", "csv", "log", "zip", "tar", "gz", "rs",
  "py", "rb", "go", "java", "c", "h", "cpp", "sh", "bat", "ps1", "exe", "dll",
]);

/** Schemes that legitimately appear without `//`. Anything else of the shape
 *  `word:rest` is host:port or a search term, not a scheme. */
const SCHEMELESS =
  /^(?:about|mailto|javascript|data|blob|file|view-source|tauri|asset|ipc|chrome|ftp|ws|wss):/i;

export function searchUrlFor(query: string): string {
  return SEARCH_ENDPOINT + encodeURIComponent(query);
}

/** True when the host is served by this machine (keeps http, since dev servers
 *  rarely have TLS). */
function isLocalHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * Resolve what the user typed into either a URL to navigate to, or a search.
 * Returns "" for empty input so the caller can ignore it.
 */
export function resolveOmniboxInput(raw: string): string {
  const t = raw.trim();
  if (!t) return "";

  // 1. Explicit scheme wins outright — including the ones the security policy
  //    will refuse (file:, javascript:). Those must reach the policy and be
  //    reported as blocked, NOT be silently turned into a web search: a user who
  //    typed file:///C:/ deserves to be told no, not handed search results.
  //
  //    A scheme needs either `//` or membership of the schemeless set. Matching
  //    bare `word:` is wrong: `localhost:3000` and `myserver:8080` are
  //    host:port, and treating them as schemes returned them with no scheme at
  //    all, which navigated nowhere.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (SCHEMELESS.test(t)) return t;

  // 2. Whitespace means it cannot be a URL.
  if (/\s/.test(t)) return searchUrlFor(t);

  // Split off path/query/fragment, then host and port.
  const authority = t.split(/[/?#]/)[0];
  if (!authority) return searchUrlFor(t);

  // IPv6 literal, e.g. [::1]:8080
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close > 0) return `http://${t}`;
    return searchUrlFor(t);
  }

  const colon = authority.lastIndexOf(":");
  const host = (colon > 0 ? authority.slice(0, colon) : authority).toLowerCase();
  const port = colon > 0 ? authority.slice(colon + 1) : "";

  // A non-numeric "port" is not a port — `note:todo` is a search, not a host.
  if (port && !/^\d+$/.test(port)) return searchUrlFor(t);

  // 3a. Local addresses keep http.
  if (isLocalHostname(host)) return `http://${t}`;

  // 3b. An explicit numeric port means the user named a host deliberately,
  //     even without a dot (`myserver:8080`). Chrome navigates these too.
  if (port) return `http://${t}`;

  // 4. A dot with a plausible TLD. Trailing dots are legal in hostnames
  //    (`google.se.`) so they are ignored for this test.
  const labels = host.replace(/\.$/, "").split(".");
  if (labels.length >= 2) {
    const tld = labels[labels.length - 1];
    const looksLikeTld = /^[a-z]{2,}$/.test(tld) && !FILE_LIKE_SUFFIXES.has(tld);
    // Every label must be non-empty, or it is not a hostname (`a..b`).
    if (looksLikeTld && labels.every((l) => l.length > 0)) {
      return `https://${t}`;
    }
  }

  // 5. One word, no dot, no port: a search.
  return searchUrlFor(t);
}

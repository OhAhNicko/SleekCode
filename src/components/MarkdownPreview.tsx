import { useMemo, useRef, useCallback, useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openImageFileInViewer } from "../lib/screenshots";

/**
 * Rendered markdown for FileViewerPane's MD toggle.
 *
 * All visual styling lives in the `.ezy-md` block in index.css — the overrides
 * below exist only where BEHAVIOUR is needed, not for looks:
 *
 *   - links: `window.open` is blocked inside the WebView, so external URLs go
 *     through Tauri's opener plugin. Relative links resolve against the
 *     markdown file's own directory and open that file in the editor, which is
 *     what a reader clicking `[architecture](docs/architecture.md)` in a README
 *     actually wants.
 *   - images: a relative `src` has no meaningful base inside the WebView, and
 *     Tauri's asset protocol is deliberately disabled, so local paths are
 *     resolved and inlined as `data:` URIs via `read_image_data_uri`.
 *   - headings: slugged so in-document `#anchor` links (common in generated
 *     tables of contents) can scroll.
 *   - tables: wrapped in their own horizontal scroll container so a wide table
 *     never drags the whole document sideways in a narrow pane.
 */

interface MarkdownPreviewProps {
  source: string;
  /** Absolute path of the markdown file — the base for relative links/images. */
  filePath: string;
  /**
   * Render one muted line summarising the frontmatter (type, revision, author)
   * above the document. Off by default: on an ordinary README the block is
   * bookkeeping the reader did not ask for.
   */
  frontmatterSummary?: boolean;
}

/**
 * Split a leading YAML frontmatter block off a markdown source.
 *
 * Markdown has no notion of frontmatter, so `---\nid: …\n---` renders as a
 * setext H2 followed by a paragraph of key-value soup — the document appears to
 * start with a heading nobody wrote. Every knowledge document carries
 * frontmatter, so stripping it is the difference between a readable note and a
 * mangled one, and it is a plain improvement for any other file too.
 *
 * Deliberately not a YAML parser: only a block that STARTS the file counts, and
 * the search for its closing fence is bounded, so a document that merely uses
 * `---` as a horizontal rule can never lose its first section.
 */
const MAX_FRONTMATTER_LINES = 40;

export function splitFrontmatter(source: string): { fm: string | null; body: string } {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) return { fm: null, body: source };
  const lines = source.split("\n");
  const limit = Math.min(lines.length, MAX_FRONTMATTER_LINES + 1);
  for (let i = 1; i < limit; i++) {
    if (lines[i].trimEnd() === "---") {
      return {
        fm: lines.slice(1, i).join("\n"),
        body: lines.slice(i + 1).join("\n"),
      };
    }
  }
  return { fm: null, body: source };
}

/** Pull the few keys worth showing, without a YAML dependency. */
function frontmatterLine(fm: string): string {
  const pick = (key: string): string | undefined => {
    const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  const parts: string[] = [];
  const type = pick("type");
  if (type) parts.push(type);
  const revision = pick("revision");
  if (revision) parts.push(`rev ${revision}`);
  const updatedBy = pick("updated_by");
  if (updatedBy) parts.push(`updated by ${updatedBy}`);
  return parts.join(" · ");
}

/**
 * Props react-markdown hands a custom component: the intrinsic element's props
 * plus the mdast `node`. `node` is NOT a valid DOM attribute, so every override
 * below destructures it away before spreading the rest onto real elements —
 * otherwise React logs an unknown-prop warning for each one.
 */
type MdProps<T extends keyof React.JSX.IntrinsicElements> =
  React.ComponentProps<T> & { node?: unknown };

/** Directory portion of an absolute path, separator-agnostic (Windows + POSIX). */
function dirOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return idx === -1 ? "" : filePath.slice(0, idx);
}

/**
 * Resolve `rel` against `baseDir`, collapsing `.` and `..` segments. Kept
 * deliberately simple — there is no path module in the renderer, and markdown
 * links are ordinary relative paths, not shell globs.
 */
function resolveRelative(baseDir: string, rel: string): string {
  const cleanRel = rel.replace(/\\/g, "/").split(/[?#]/)[0];
  if (!cleanRel) return "";
  const base = baseDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = (cleanRel.startsWith("/") ? cleanRel : `${base}/${cleanRel}`).split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "." || seg === "") {
      // Preserve a leading "" so POSIX absolute paths keep their root slash.
      if (seg === "" && out.length === 0) out.push("");
      continue;
    }
    if (seg === "..") {
      if (out.length > 1 || (out.length === 1 && out[0] !== "")) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

const EXTERNAL = /^(https?:|mailto:|tel:)/i;

/**
 * An image in a markdown document. Remote and `data:` sources render directly;
 * a local path is inlined as a data URI, since the WebView has no filesystem
 * access of its own. A path that cannot be read falls back to its alt text
 * rather than a broken-image icon.
 */
function MarkdownImage({
  src,
  alt,
  baseDir,
  ...rest
}: React.ComponentProps<"img"> & { baseDir: string }) {
  const raw = typeof src === "string" ? src : "";
  const isInline = !raw || EXTERNAL.test(raw) || raw.startsWith("data:");
  const [resolved, setResolved] = useState<string | null>(isInline ? raw : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isInline) {
      setResolved(raw);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setResolved(null);
    setFailed(false);
    invoke<string>("read_image_data_uri", { path: resolveRelative(baseDir, raw) })
      .then((uri) => {
        if (!cancelled) setResolved(uri);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [raw, baseDir, isInline]);

  if (failed) {
    return (
      <span style={{ color: "var(--ezy-text-muted)", fontSize: "calc(var(--ezy-font-scale, 1) * 12px)" }}>
        {alt || raw}
      </span>
    );
  }
  if (!resolved) return null;
  // Local images open in the screenshot viewer on click; external/data: URIs
  // have no file to open.
  const clickPath = isInline ? null : resolveRelative(baseDir, raw);
  return (
    <img
      {...rest}
      src={resolved}
      alt={alt}
      loading="lazy"
      onClick={clickPath ? () => void openImageFileInViewer(clickPath) : undefined}
      style={clickPath ? { ...rest.style, cursor: "zoom-in" } : rest.style}
    />
  );
}

/** Flatten React children to plain text so headings can be slugged. */
function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in (node as never)) {
    return textOf((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}

/** GitHub-compatible heading slug. */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

export default function MarkdownPreview({
  source,
  filePath,
  frontmatterSummary,
}: MarkdownPreviewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const baseDir = useMemo(() => dirOf(filePath), [filePath]);
  const { fm, body } = useMemo(() => splitFrontmatter(source), [source]);
  const summary = useMemo(
    () => (frontmatterSummary && fm ? frontmatterLine(fm) : ""),
    [frontmatterSummary, fm],
  );

  const handleLinkClick = useCallback(
    (href: string) => (e: React.MouseEvent) => {
      e.preventDefault();
      if (!href) return;

      if (EXTERNAL.test(href)) {
        openUrl(href).catch(() => {});
        return;
      }

      if (href.startsWith("#")) {
        const target = rootRef.current?.querySelector(
          `#${CSS.escape(href.slice(1).toLowerCase())}`
        );
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      // Relative path → open it in the editor, same channel the sidebar and
      // terminal Ctrl+Click use.
      const resolved = resolveRelative(baseDir, href);
      if (!resolved) return;
      window.dispatchEvent(
        new CustomEvent("made:open-file", { detail: { filePath: resolved } })
      );
    },
    [baseDir]
  );

  const components = useMemo(
    () => ({
      a: ({ node: _node, href, children, ...rest }: MdProps<"a">) => (
        <a
          {...rest}
          href={href ?? "#"}
          onClick={handleLinkClick(href ?? "")}
          data-tooltip={href}
        >
          {children}
        </a>
      ),
      img: ({ node: _node, ...rest }: MdProps<"img">) => (
        <MarkdownImage {...rest} baseDir={baseDir} />
      ),
      table: ({ node: _node, children, ...rest }: MdProps<"table">) => (
        <div className="ezy-md-table-wrap">
          <table {...rest}>{children}</table>
        </div>
      ),
      h1: ({ node: _node, children, ...rest }: MdProps<"h1">) => (
        <h1 {...rest} id={slugify(textOf(children))}>{children}</h1>
      ),
      h2: ({ node: _node, children, ...rest }: MdProps<"h2">) => (
        <h2 {...rest} id={slugify(textOf(children))}>{children}</h2>
      ),
      h3: ({ node: _node, children, ...rest }: MdProps<"h3">) => (
        <h3 {...rest} id={slugify(textOf(children))}>{children}</h3>
      ),
      h4: ({ node: _node, children, ...rest }: MdProps<"h4">) => (
        <h4 {...rest} id={slugify(textOf(children))}>{children}</h4>
      ),
    }),
    [handleLinkClick, baseDir]
  );

  return (
    <div ref={rootRef} className="ezy-md h-full overflow-auto">
      {summary && (
        <div
          style={{
            fontSize: "calc(var(--ezy-font-scale, 1) * 11px)",
            color: "var(--ezy-text-muted)",
            marginBottom: 6,
          }}
        >
          {summary}
        </div>
      )}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}

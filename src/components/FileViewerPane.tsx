import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import LoadingDots from "./LoadingDots";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState, Annotation, Compartment, Transaction } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, undo, undoDepth } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter } from "@codemirror/language";
import { closeBrackets } from "@codemirror/autocomplete";
import { search } from "@codemirror/search";
import { invoke } from "@tauri-apps/api/core";
import { SiMarkdown } from "react-icons/si";
import { getTheme } from "../lib/themes";
import { buildEditorTheme } from "../lib/editor-theme";
import { useAppStore } from "../store";
import { useKnowledgeStore } from "../store/knowledgeStore";
import { watchFile } from "../lib/file-watcher";
import type { Extension } from "@codemirror/state";
import PaneSearchBar from "./PaneSearchBar";
import MarkdownPreview from "./MarkdownPreview";
import { registerSurfaceActions, unregisterSurfaceActions } from "../lib/surface-actions";
import { useCodeMirrorSearch } from "../hooks/usePaneSearch";
import { registerPaneSearch, unregisterPaneSearch } from "../lib/pane-search-registry";
import PaneExpandButton from "./PaneExpandButton";
import { canonicalProjectKey, isMemoryFilePath, projectRootForMemoryFile } from "../lib/knowledge/keys";
import { markOwnEdit, rescanProject } from "../lib/knowledge/api";

interface FileViewerPaneProps {
  initialFiles: string[];
  initialActive: string;
  onClose: () => void;
  paneId?: string;
}

/**
 * Marks a doc replacement that came from disk rather than from the user, so the
 * updateListener does not flag the buffer as modified when we live-reload it.
 */
const ExternalReload = Annotation.define<boolean>();

function detectLanguage(filePath: string): Extension[] {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
    case "jsx":
      return [javascript()];
    case "ts":
    case "tsx":
      return [javascript({ typescript: true, jsx: ext.includes("x") })];
    case "py":
      return [python()];
    case "css":
      return [css()];
    // Shared knowledge documents are markdown, and they are read in the source
    // view as often as in the preview (frontmatter only exists there), so the
    // source view highlights them rather than showing a wall of plain text.
    case "md":
    case "markdown":
    case "mdx":
      return [markdown()];
    default:
      return [];
  }
}

function getLanguageLabel(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js": return "JavaScript";
    case "jsx": return "JSX";
    case "ts": return "TypeScript";
    case "tsx": return "TSX";
    case "py": return "Python";
    case "css": return "CSS";
    case "html": return "HTML";
    case "json": return "JSON";
    case "md": return "Markdown";
    case "rs": return "Rust";
    case "toml": return "TOML";
    case "yaml":
    case "yml": return "YAML";
    default: return ext?.toUpperCase() ?? "Plain";
  }
}

function isMarkdown(filePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filePath);
}

function getFileIcon(filePath: string) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  let color = "var(--ezy-text-muted)";
  let label = "";

  switch (ext) {
    case "ts": color = "#3178c6"; label = "TS"; break;
    case "tsx": color = "#3178c6"; label = "TSX"; break;
    case "js": color = "#f0db4f"; label = "JS"; break;
    case "jsx": color = "#f0db4f"; label = "JSX"; break;
    case "py": color = "#3776ab"; label = "PY"; break;
    case "rs": color = "#dea584"; label = "RS"; break;
    case "css": color = "#563d7c"; label = "CSS"; break;
    case "json": color = "#6d8086"; label = "{ }"; break;
    default: label = ext?.toUpperCase().slice(0, 3) ?? ""; break;
  }

  return (
    <span
      className="text-[9px] font-bold leading-none rounded px-1 py-[1px] shrink-0"
      style={{
        color: "#fff",
        backgroundColor: color,
        minWidth: 18,
        textAlign: "center",
      }}
    >
      {label}
    </span>
  );
}

export default function FileViewerPane({
  initialFiles,
  initialActive,
  onClose,
  paneId,
}: FileViewerPaneProps) {
  const [files, setFiles] = useState<string[]>(initialFiles);
  const [activeFile, setActiveFile] = useState(initialActive);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modified, setModified] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusBump, setSearchFocusBump] = useState(0);
  const cmSearch = useCodeMirrorSearch(viewRef);
  const themeId = useAppStore((s) => s.themeId);
  const perProjectEditor = useAppStore((s) => s.perProjectEditor);
  const editorWordWrap = useAppStore((s) => s.editorWordWrap ?? true);
  const theme = getTheme(themeId);
  const tabsRef = useRef<HTMLDivElement>(null);

  /** Loaded file text. `null` means "not loaded yet" and gates the editor mount. */
  const [content, setContent] = useState<string | null>(null);
  const contentRef = useRef<string | null>(null);
  /** Bumped on every successful load so the mount effect re-runs with fresh text. */
  const [loadSeq, setLoadSeq] = useState(0);
  /** Set when disk changed underneath unsaved edits — holds the disk version. */
  const [diskConflict, setDiskConflict] = useState(false);
  const pendingDiskRef = useRef<string | null>(null);
  /**
   * What we believe is currently on disk — updated on load, on our own save,
   * and on every accepted reload. The watcher fires for our OWN writes too, so
   * comparing against this (rather than against the buffer) is what stops a
   * save-then-keep-typing sequence from raising a bogus conflict.
   */
  const diskTextRef = useRef<string | null>(null);
  /** Per-file source/preview choice. Markdown defaults to preview. */
  const [previewByFile, setPreviewByFile] = useState<Record<string, boolean>>({});
  /** True while the editor's history has something to step back through —
   *  drives the header's undo arrow. Reset with each file load (the state
   *  rebuild starts a fresh history). */
  const [canUndo, setCanUndo] = useState(false);
  /** Save-confirmed tick: a nonce so consecutive saves re-fire the pop-in;
   *  0 = hidden. Cleared back to the disk icon after a short hold. */
  const [saveFlash, setSaveFlash] = useState(0);
  const saveFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (saveFlashTimer.current) clearTimeout(saveFlashTimer.current);
    },
    [],
  );

  /**
   * Holds the soft-wrap extension so toggling the setting can reconfigure the
   * LIVE editor. Rebuilding the EditorView instead would throw away the caret,
   * scroll position and undo history every time the toggle flips.
   */
  const wrapCompartment = useMemo(() => new Compartment(), []);
  // Read at mount time without making the setting a dependency of the mount
  // effect — the compartment handles changes.
  const wordWrapRef = useRef(editorWordWrap);
  wordWrapRef.current = editorWordWrap;

  const activeIsMarkdown = isMarkdown(activeFile);
  // Markdown defaults to the rendered view — EXCEPT shared-memory files, which
  // are opened to be EDITED: the Knowledge sidebar's "Open" must land in the
  // source (raised 2026-08-08), and its separate "Open preview" action still
  // forces the rendered view via the `markdownPreview` event flag.
  const showPreview =
    activeIsMarkdown && (previewByFile[activeFile] ?? !isMemoryFilePath(activeFile));

  // Mirrors for use inside the watcher callback, which is created once per file
  // and must not close over stale render values.
  const modifiedRef = useRef(modified);
  modifiedRef.current = modified;
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;

  useEffect(() => {
    if (!paneId) return;
    registerPaneSearch(paneId, () => {
      setSearchOpen(true);
      setSearchFocusBump((n) => n + 1);
    });
    return () => unregisterPaneSearch(paneId);
  }, [paneId]);

  // Closing the file or switching tabs resets the search bar naturally on
  // re-mount. Entering the markdown preview also closes it: search is backed by
  // CodeMirror, which is unmounted in preview mode, so leaving it "open" would
  // pop an inert bar back up on the next switch to source.
  useEffect(() => {
    setSearchOpen(false);
    cmSearch.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile, showPreview]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    cmSearch.reset();
    viewRef.current?.focus();
  }, [cmSearch]);

  const fileName = activeFile.split(/[\\/]/).pop() || activeFile;
  const langLabel = getLanguageLabel(activeFile);

  /**
   * Closing the pane. By default the editor is one global surface — a file
   * opens in every project tab at once, so the X has to close it in every
   * project tab too, otherwise closing it "once" leaves copies behind in every
   * other project. With `perProjectEditor` on, each tab owns its own editor and
   * the X is local again.
   *
   * Closing also drops the Knowledge sidebar's row highlight for any memory
   * file open here: with no editor showing the note, "active" is a claim the
   * sidebar can no longer back (user, 2026-08-08).
   */
  const requestClose = useCallback(() => {
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const openMemory = files.filter(isMemoryFilePath).map(norm);
    if (openMemory.length > 0) {
      const k = useKnowledgeStore.getState();
      for (const proj of Object.values(k.projects)) {
        if (!proj.selectedNoteId) continue;
        const sel = proj.notes.find((n) => n.id === proj.selectedNoteId);
        if (sel?.filePath && openMemory.includes(norm(sel.filePath))) {
          k.select(proj.path, null);
        }
      }
    }
    if (perProjectEditor) {
      onClose();
      return;
    }
    window.dispatchEvent(new CustomEvent("made:close-fileviewer"));
  }, [files, perProjectEditor, onClose]);

  /** Close one file's tab; closing the last one closes the pane. Shared by
   *  the tab X and the row-click toggle. */
  const filesRef = useRef(files);
  filesRef.current = files;
  const closeFile = useCallback(
    (filePath: string) => {
      const next = filesRef.current.filter((f) => f !== filePath);
      if (next.length === 0) {
        requestClose();
        return;
      }
      if (activeFileRef.current === filePath) {
        const idx = filesRef.current.indexOf(filePath);
        setActiveFile(next[Math.min(idx, next.length - 1)]);
      }
      setFiles(next);
    },
    [requestClose],
  );

  // Listen for files being added to this viewer
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.filePath) return;
      // In per-project mode only the viewer the event was addressed to takes
      // the file; in global mode every viewer mirrors it.
      if (perProjectEditor && detail.viewerId && detail.viewerId !== paneId) return;
      // Row-click TOGGLE (user, 2026-08-08): clicking the file that is
      // already showing closes it. Only for bare row clicks — a link
      // carrying a line number or a preview request must never close the
      // file it targets — and never over unsaved edits.
      if (
        detail.toggle === true &&
        detail.lineNumber == null &&
        detail.markdownPreview !== true &&
        detail.filePath === activeFileRef.current &&
        filesRef.current.includes(detail.filePath)
      ) {
        if (!modifiedRef.current) closeFile(detail.filePath);
        return;
      }
      setFiles((prev) => {
        if (prev.includes(detail.filePath)) {
          setActiveFile(detail.filePath);
          return prev;
        }
        const next = [...prev, detail.filePath];
        setActiveFile(detail.filePath);
        return next;
      });
    };
    window.addEventListener("made:fileviewer-add", handler);
    return () => window.removeEventListener("made:fileviewer-add", handler);
  }, [perProjectEditor, paneId, closeFile]);

  // "Open preview" — an opener can ask for the rendered view rather than the
  // source. Recorded straight from `made:open-file` because the relay that
  // actually adds the file (PaneGrid) forwards only the path. Markdown already
  // defaults to preview, so this only matters for a file the user had
  // previously flipped to source; setting it is idempotent either way.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.filePath || detail.markdownPreview !== true) return;
      if (!isMarkdown(detail.filePath)) return;
      setPreviewByFile((prev) =>
        prev[detail.filePath] === true ? prev : { ...prev, [detail.filePath]: true },
      );
    };
    window.addEventListener("made:open-file", handler);
    return () => window.removeEventListener("made:open-file", handler);
  }, []);

  /** Current buffer text: the live editor when mounted, else the last snapshot. */
  const getCurrentText = useCallback(
    () => (viewRef.current ? viewRef.current.state.doc.toString() : contentRef.current ?? ""),
    []
  );

  // Expose editor-tab handlers to the context menu.
  const edRef = useRef<Record<string, (id: string) => void>>({});
  useEffect(() => {
    registerSurfaceActions("editor-tab", {
      save: () => edRef.current.save?.(""),
      close: (id) => edRef.current.close?.(id),
      closeOthers: (id) => edRef.current.closeOthers?.(id),
      togglePreview: (id) => edRef.current.togglePreview?.(id),
    });
    return () => unregisterSurfaceActions("editor-tab");
  }, []);

  const handleSave = useCallback(async () => {
    if (contentRef.current === null && !viewRef.current) return;
    setSaving(true);
    try {
      const text = getCurrentText();
      // Saving a shared-memory file: tell the knowledge service this write is
      // ours BEFORE it hits disk. Its watcher cannot tell our save from an
      // agent's, and guessing wrong costs twice — the revision is credited to
      // the wrong author, and the user gets a "knowledge updated" toast for the
      // edit they just made. Fire-and-forget: attribution is worth degrading,
      // the save is not.
      const memoryRoot = projectRootForMemoryFile(activeFile);
      if (memoryRoot) {
        await markOwnEdit(memoryRoot, activeFile).catch(() => {});
      }
      await invoke("write_file", { path: activeFile, content: text });
      contentRef.current = text;
      diskTextRef.current = text;
      setModified(false);
      // Our own write wins — any conflict we were holding is now resolved.
      setDiskConflict(false);
      pendingDiskRef.current = null;
      // Import the save NOW rather than waiting for the filesystem watcher:
      // on `\\wsl.localhost` projects (9P) notify provably never fires, and
      // this is MADE's own write — there is nothing to wait for. The rescan
      // reconciles and credits the revision to the user via the own-edit mark
      // set above. Then the buffer is refreshed from disk: the reconcile
      // RE-PROJECTED the file with bumped frontmatter (revision, updated_by),
      // and a buffer still carrying the old revision makes the NEXT save a
      // stale-base write — a manufactured conflict on every second save
      // (found at runtime 2026-08-08; the viewer's own disk watcher is
      // notify-based too and equally blind on 9P). The user's keystrokes
      // outrank the refresh: skip it if they typed or switched files.
      if (memoryRoot) {
        const savedFile = activeFile;
        void (async () => {
          await rescanProject(memoryRoot).catch(() => {});
          try {
            const disk = await invoke<string>("read_file", { path: savedFile });
            if (activeFileRef.current === savedFile && !modifiedRef.current) {
              applyDisk(disk);
            }
          } catch {
            // Nothing lost — the next save simply imports against head.
          }
        })();
      }
      // Confirmation tick in the header — nonce-keyed so back-to-back saves
      // each re-fire the pop-in (the ScreenshotsOverlay copy-check pattern).
      setSaveFlash((n) => n + 1);
      if (saveFlashTimer.current) clearTimeout(saveFlashTimer.current);
      saveFlashTimer.current = setTimeout(() => setSaveFlash(0), 1200);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [activeFile, getCurrentText]);

  // ── Load the active file ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setModified(false);
    setDiskConflict(false);
    pendingDiskRef.current = null;
    // Cleared synchronously so the mount effect below (which runs after this
    // one on the same commit) cannot mount the previous file's text.
    contentRef.current = null;
    diskTextRef.current = null;
    setContent(null);

    (async () => {
      try {
        const text = await invoke<string>("read_file", { path: activeFile });
        if (cancelled) return;
        contentRef.current = text;
        diskTextRef.current = text;
        setContent(text);
        setLoadSeq((n) => n + 1);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeFile]);

  // ── Live reload: react to the file changing on disk ─────────────────────
  //
  // Someone else wrote the file: another MADE window, an AI agent in a terminal
  // pane, a git checkout, an external editor. Re-read and reconcile.
  const applyDisk = useCallback((disk: string) => {
    const view = viewRef.current;
    if (view) {
      // Replace the doc in place rather than rebuilding the EditorView, so the
      // caret, selection and scroll position survive the reload.
      const scrollTop = view.scrollDOM.scrollTop;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: disk },
        selection: {
          anchor: Math.min(sel.anchor, disk.length),
          head: Math.min(sel.head, disk.length),
        },
        // Kept OUT of the undo history: a disk reload is not a user edit, and
        // recording it made Ctrl+Z right after a save "undo" the frontmatter
        // refresh instead of the user's last typing.
        annotations: [ExternalReload.of(true), Transaction.addToHistory.of(false)],
      });
      view.scrollDOM.scrollTop = scrollTop;
    }
    contentRef.current = disk;
    diskTextRef.current = disk;
    setContent(disk);
    setModified(false);
    setDiskConflict(false);
    pendingDiskRef.current = null;
  }, []);

  // Memory files get a second change signal beside the file watcher: the
  // knowledge service's own revision counter. On `\\wsl.localhost` projects
  // the watcher below never fires (9P emits no notifications), but every
  // import — external edit swept in by the service's poll, an agent's MCP
  // write — bumps the project revision, which this store subscription sees.
  // A clean buffer follows the import; unsaved edits stay put and the save
  // path's conflict machinery arbitrates, same as ever.
  const activeMemoryRoot = projectRootForMemoryFile(activeFile);
  const activeMemoryKey = activeMemoryRoot ? canonicalProjectKey(activeMemoryRoot) : "";
  const knowledgeRevision = useKnowledgeStore((s) =>
    activeMemoryKey ? (s.projects[activeMemoryKey]?.revision ?? 0) : 0,
  );
  useEffect(() => {
    if (!activeMemoryRoot || knowledgeRevision === 0) return;
    if (modifiedRef.current) return;
    const file = activeFileRef.current;
    void invoke<string>("read_file", { path: file })
      .then((disk) => {
        if (activeFileRef.current !== file) return;
        if (modifiedRef.current) return;
        if (disk !== (diskTextRef.current ?? contentRef.current)) applyDisk(disk);
      })
      .catch(() => {});
    // applyDisk is stable ([] deps) and declared above; refs carry the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knowledgeRevision, activeMemoryRoot]);

  useEffect(() => {
    if (!activeFile) return;
    return watchFile(activeFile, async () => {
      let disk: string;
      try {
        disk = await invoke<string>("read_file", { path: activeFile });
      } catch {
        // Mid-rename, deleted, or briefly locked. Keep showing what we have —
        // a real delete surfaces when the user next saves.
        return;
      }
      // The user switched files while the read was in flight.
      if (activeFileRef.current !== activeFile) return;

      // Nothing actually changed since we last synced. This is the common case:
      // the watcher also fires for our own writes, and a save is often followed
      // immediately by more typing — comparing against the buffer instead would
      // report a phantom conflict there.
      if (disk === diskTextRef.current) return;
      diskTextRef.current = disk;

      if (disk === getCurrentText()) {
        // An external edit converged on exactly what we already show; there is
        // nothing left unsaved and nothing to reconcile.
        setModified(false);
        setDiskConflict(false);
        pendingDiskRef.current = null;
        return;
      }

      if (modifiedRef.current) {
        // Never discard unsaved work — park the disk version and let the user
        // choose from the bar.
        pendingDiskRef.current = disk;
        setDiskConflict(true);
        return;
      }

      applyDisk(disk);
    });
  }, [activeFile, applyDisk, getCurrentText]);

  // ── Mount CodeMirror (source mode only) ─────────────────────────────────
  useEffect(() => {
    if (showPreview) return;
    if (contentRef.current === null) return;
    if (!containerRef.current) return;

    const langExts = detectLanguage(activeFile);
    const editorTheme = buildEditorTheme(theme);

    const state = EditorState.create({
      doc: contentRef.current,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        foldGutter(),
        history(),
        bracketMatching(),
        closeBrackets(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        ...langExts,
        editorTheme,
        search(),
        wrapCompartment.of(wordWrapRef.current ? EditorView.lineWrapping : []),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          {
            key: "Mod-s",
            run: () => {
              handleSave();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          // The header's undo arrow lights up exactly when Ctrl+Z would do
          // something.
          setCanUndo(undoDepth(update.state) > 0);
          // A live reload from disk is not a user edit.
          if (update.transactions.some((tr) => tr.annotation(ExternalReload))) return;
          setModified(true);
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    setCanUndo(false); // fresh state = fresh history

    return () => {
      // Snapshot the buffer before tearing the view down so the markdown
      // preview (and a later save) sees unsaved edits, not the last disk read.
      contentRef.current = view.state.doc.toString();
      setContent(contentRef.current);
      view.destroy();
      viewRef.current = null;
    };
    // `theme` is intentionally excluded: remounting on a theme change would
    // discard the caret, scroll position and undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile, showPreview, loadSeq]);

  // Apply a word-wrap toggle to the already-mounted editor.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapCompartment.reconfigure(
        editorWordWrap ? EditorView.lineWrapping : []
      ),
    });
  }, [editorWordWrap, wrapCompartment]);

  const handleCloseTab = useCallback(
    (filePath: string, e: React.MouseEvent) => {
      e.stopPropagation();
      closeFile(filePath);
    },
    [closeFile]
  );

  const handleTabClick = useCallback((filePath: string) => {
    setActiveFile(filePath);
  }, []);

  const togglePreview = useCallback(() => {
    setPreviewByFile((prev) => ({
      ...prev,
      [activeFile]: !(prev[activeFile] ?? true),
    }));
  }, [activeFile]);
  // handleCloseTab only uses the event for stopPropagation (it is wired to a
  // click on the tab's X, inside the tab's own click handler). The menu path
  // has no event, so pass a stand-in rather than reshaping the handler.
  const noEvent = { stopPropagation() {} } as React.MouseEvent;
  edRef.current = {
    save: () => void handleSave(),
    close: (fp) => handleCloseTab(fp, noEvent),
    closeOthers: (fp) => { for (const other of files.filter((f) => f !== fp)) handleCloseTab(other, noEvent); },
    togglePreview: () => togglePreview(),
  };

  const previewSource = useMemo(() => content ?? "", [content]);

  return (
    <div
      className="flex flex-col h-full w-full"
      data-pane-id={paneId}
      style={{ backgroundColor: "var(--ezy-bg)" }}
    >
      {/* Tab bar */}
      <div
        ref={tabsRef}
        className="flex items-center shrink-0 overflow-x-auto"
        style={{
          height: 32,
          backgroundColor: "var(--ezy-surface)",
          borderBottom: "1px solid var(--ezy-border)",
        }}
      >
        {/* File tabs */}
        <div className="flex items-stretch flex-1 min-w-0 overflow-x-auto">
          {files.map((fp) => {
            const isActive = fp === activeFile;
            const name = fp.split(/[\\/]/).pop() || fp;

            return (
              <div
                key={fp}
                data-ctx-surface="editor-tab"
                data-ctx-id={fp}
                data-ctx-label={name}
                data-ctx-dirty={isActive && modified ? "1" : ""}
                onClick={() => handleTabClick(fp)}
                className="flex items-center gap-1.5 px-3 cursor-pointer shrink-0 relative group"
                style={{
                  height: 32,
                  borderRight: "1px solid var(--ezy-border-subtle)",
                  backgroundColor: isActive ? "var(--ezy-bg)" : "transparent",
                  borderBottom: isActive ? "2px solid var(--ezy-accent)" : "2px solid transparent",
                  transition: "background-color 100ms ease",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)";
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                {getFileIcon(fp)}
                <span
                  className="text-[11px] whitespace-nowrap"
                  style={{
                    color: isActive ? "var(--ezy-text)" : "var(--ezy-text-secondary)",
                    fontWeight: isActive ? 500 : 400,
                  }}
                >
                  {name}
                </span>
                {/* Close tab button */}
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                  style={{ color: "var(--ezy-text-muted)" }}
                  onClick={(e) => handleCloseTab(fp, e)}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ezy-red)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")}
                >
                  <path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </div>
            );
          })}
        </div>

        {/* Right side: markdown toggle + language badge + save + close pane */}
        <div className="flex items-center gap-1.5 px-2 shrink-0">
          {activeIsMarkdown && (
            <SiMarkdown
              size={14}
              className="cursor-pointer shrink-0"
              style={{
                color: showPreview ? "var(--ezy-accent)" : "var(--ezy-text-muted)",
                transition: "color 120ms ease",
              }}
              title={showPreview ? "Show markdown source" : "Show formatted markdown"}
              onClick={togglePreview}
            />
          )}
          <span
            style={{
              fontSize: "calc(var(--ezy-font-scale, 1) * 9px)",
              padding: "1px 5px",
              borderRadius: "calc(var(--ezy-radius-scale, 1) * 3px)",
              backgroundColor: "var(--ezy-border)",
              color: "var(--ezy-text-muted)",
              fontWeight: 600,
            }}
          >
            {langLabel}
          </span>
          {saving && (
            <span className="text-[10px]" style={{ color: "var(--ezy-text-muted)" }}>
              <LoadingDots>Saving</LoadingDots>
            </span>
          )}
          {!showPreview && (
            // Undo — steps the editor history back, same as Ctrl+Z. Lit only
            // when there is something to undo; focus returns to the editor so
            // typing continues where it left off.
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="var(--ezy-text-muted)"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={canUndo ? "cursor-pointer hover:opacity-80" : undefined}
              data-tooltip={canUndo ? "Undo (Ctrl+Z)" : "Nothing to undo"}
              style={{ opacity: canUndo ? 1 : 0.35, transition: "opacity 120ms ease" }}
              onClick={() => {
                const view = viewRef.current;
                if (!view || !canUndo) return;
                undo(view);
                view.focus();
              }}
            >
              <path d="M6.5 3.5 3 7l3.5 3.5" />
              <path d="M3 7h6a4 4 0 0 1 4 4v1.5" />
            </svg>
          )}
          {saveFlash > 0 ? (
            // Save confirmed — the same green pop-in the screenshots viewer
            // uses for copy. Takes the disk icon's slot so the header never
            // changes width.
            <svg
              key={saveFlash}
              width="12"
              height="12"
              viewBox="0 0 12 12"
              aria-hidden="true"
              className="check-pop-in"
              style={{ flexShrink: 0 }}
            >
              <path
                d="M2.5 6.5 L5 9 L9.5 3.5"
                stroke="#3fb950"
                strokeWidth="1.6"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            // Unsaved edits read from the icon itself — accent strokes while
            // modified, quiet grey when clean (the "modified" text label it
            // replaces looked out of place).
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke={modified ? "var(--ezy-accent)" : "var(--ezy-text-muted)"}
              strokeWidth="1.3"
              strokeLinecap="round"
              className="cursor-pointer hover:opacity-80"
              style={{
                opacity: modified ? 1 : 0.4,
                transition: "stroke 120ms ease, opacity 120ms ease",
              }}
              onClick={handleSave}
            >
              <path d="M3 14V2h8l2 2v10H3z" />
              <path d="M5 2v4h5V2" />
              <path d="M5 14v-4h6v4" />
            </svg>
          )}
          <PaneExpandButton paneId={paneId} />
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            className="cursor-pointer"
            style={{ color: "var(--ezy-text-muted)" }}
            onClick={requestClose}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ezy-red)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ezy-text-muted)")}
          >
            <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      </div>

      {/* Disk conflict bar — the file changed underneath unsaved edits. */}
      {diskConflict && (
        <div
          className="flex items-center gap-2 shrink-0 px-3"
          style={{
            height: 30,
            backgroundColor: "var(--ezy-surface-raised)",
            borderBottom: "1px solid var(--ezy-border)",
          }}
        >
          <span className="text-[11px] flex-1 min-w-0 truncate" style={{ color: "var(--ezy-text-secondary)" }}>
            {fileName} changed on disk. You have unsaved edits.
          </span>
          <button
            onClick={() => {
              if (pendingDiskRef.current !== null) applyDisk(pendingDiskRef.current);
            }}
            className="text-[10px] px-2 py-[3px] rounded shrink-0 cursor-pointer"
            style={{ backgroundColor: "var(--ezy-accent-dim)", color: "#fff", fontWeight: 600 }}
          >
            Reload
          </button>
          <button
            onClick={() => {
              setDiskConflict(false);
              pendingDiskRef.current = null;
            }}
            className="text-[10px] px-2 py-[3px] rounded shrink-0 cursor-pointer"
            style={{ backgroundColor: "var(--ezy-border)", color: "var(--ezy-text)", fontWeight: 600 }}
          >
            Keep mine
          </button>
        </div>
      )}

      {/* Editor content */}
      <div className="flex-1 min-h-0 overflow-auto relative">
        {loading ? (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: "var(--ezy-text-muted)", fontSize: "calc(var(--ezy-font-scale, 1) * 13px)" }}
          >
            <LoadingDots>Loading {fileName}</LoadingDots>
          </div>
        ) : error ? (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: "var(--ezy-red)", fontSize: "calc(var(--ezy-font-scale, 1) * 13px)" }}
          >
            {error}
          </div>
        ) : null}
        {showPreview && !loading && !error ? (
          <MarkdownPreview source={previewSource} filePath={activeFile} />
        ) : (
          <div ref={containerRef} className="h-full" />
        )}
        {searchOpen && !showPreview && (
          <PaneSearchBar
            {...cmSearch}
            onClose={closeSearch}
            isActive={true}
            focusBump={searchFocusBump}
          />
        )}
      </div>
    </div>
  );
}

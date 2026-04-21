import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import type { EditorView } from "@codemirror/view";
import {
  SearchQuery,
  setSearchQuery,
  findNext as cmFindNext,
  findPrevious as cmFindPrevious,
  getSearchQuery,
} from "@codemirror/search";

export interface PaneSearchState {
  query: string;
  setQuery: (s: string) => void;
  caseSensitive: boolean;
  setCaseSensitive: (v: boolean) => void;
  regex: boolean;
  setRegex: (v: boolean) => void;
  wholeWord: boolean;
  setWholeWord: (v: boolean) => void;
  matchInfo: { index: number; count: number } | null;
  onNext: () => void;
  onPrev: () => void;
  reset: () => void;
}

const XTERM_DECORATIONS = {
  matchBackground: "#264f78",
  matchBorder: "transparent",
  matchOverviewRuler: "#8b949e",
  activeMatchBackground: "#39d353",
  activeMatchBorder: "transparent",
  activeMatchColorOverviewRuler: "#39d353",
};

/**
 * Drives the @xterm/addon-search API and returns PaneSearchBar-compatible state.
 */
export function useXtermSearch(searchAddon: SearchAddon | null): PaneSearchState {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matchInfo, setMatchInfo] = useState<{ index: number; count: number } | null>(null);

  useEffect(() => {
    if (!searchAddon) return;
    if (!("onDidChangeResults" in searchAddon)) return;
    const disposable = (searchAddon as unknown as {
      onDidChangeResults: (
        cb: (e: { resultIndex: number; resultCount: number } | undefined) => void,
      ) => { dispose(): void };
    }).onDidChangeResults((e) => {
      if (e) setMatchInfo({ index: e.resultIndex, count: e.resultCount });
      else setMatchInfo(null);
    });
    return () => disposable.dispose();
  }, [searchAddon]);

  const searchOptions = useCallback(
    (incremental: boolean) => ({
      caseSensitive,
      regex,
      wholeWord,
      incremental,
      decorations: XTERM_DECORATIONS,
    }),
    [caseSensitive, regex, wholeWord],
  );

  useEffect(() => {
    if (!searchAddon) return;
    if (query) {
      searchAddon.findNext(query, searchOptions(true));
    } else {
      searchAddon.clearDecorations();
      setMatchInfo(null);
    }
  }, [query, caseSensitive, regex, wholeWord, searchAddon, searchOptions]);

  const onNext = useCallback(() => {
    if (query && searchAddon) searchAddon.findNext(query, searchOptions(false));
  }, [query, searchAddon, searchOptions]);

  const onPrev = useCallback(() => {
    if (query && searchAddon) searchAddon.findPrevious(query, searchOptions(false));
  }, [query, searchAddon, searchOptions]);

  const reset = useCallback(() => {
    setQuery("");
    setMatchInfo(null);
    searchAddon?.clearDecorations();
  }, [searchAddon]);

  return {
    query,
    setQuery,
    caseSensitive,
    setCaseSensitive,
    regex,
    setRegex,
    wholeWord,
    setWholeWord,
    matchInfo,
    onNext,
    onPrev,
    reset,
  };
}

/** Escape a literal string so it can be embedded in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * In-DOM text search over a subtree. Walks TextNodes, wraps matches in
 * <mark data-pane-search> spans, scrolls the active match into view.
 * Respects case/regex/wholeWord flags. Skips <script>, <style>, and any
 * element with [data-no-search].
 *
 * Debounces heavy DOM mutation to 80ms and caps at 2000 matches.
 */
export function useDomTextSearch(
  containerRef: React.MutableRefObject<HTMLElement | null>,
): PaneSearchState {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matchInfo, setMatchInfo] = useState<{ index: number; count: number } | null>(null);

  // Active marks on screen, in document order.
  const marksRef = useRef<HTMLElement[]>([]);
  const activeIdxRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearMarks = () => {
    const marks = marksRef.current;
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    }
    marksRef.current = [];
    activeIdxRef.current = 0;
  };
  // Merge adjacent text nodes (created when we unwrap marks). Keeps future
  // searches matching across what used to be mark boundaries.
  const normalizeContainer = () => {
    const root = containerRef.current;
    if (root) root.normalize();
  };

  const runSearch = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;

    clearMarks();
    normalizeContainer();

    if (!query) {
      setMatchInfo(null);
      return;
    }

    // Build regex for matching.
    let re: RegExp;
    try {
      if (regex) {
        const flags = caseSensitive ? "g" : "gi";
        const source = wholeWord ? `\\b(?:${query})\\b` : query;
        re = new RegExp(source, flags);
      } else {
        const escaped = escapeRegExp(query);
        const source = wholeWord ? `\\b${escaped}\\b` : escaped;
        const flags = caseSensitive ? "g" : "gi";
        re = new RegExp(source, flags);
      }
    } catch {
      setMatchInfo({ index: 0, count: 0 });
      return;
    }

    // Walk text nodes in document order, skipping mark-killers.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("[data-no-search]")) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.nodeValue || !node.nodeValue.length) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const hits: Array<{ node: Text; start: number; end: number }> = [];
    const MAX = 2000;
    let current: Node | null = walker.nextNode();
    while (current) {
      const text = (current as Text).nodeValue ?? "";
      if (text.length === 0) {
        current = walker.nextNode();
        continue;
      }
      // Reset lastIndex for stateful global regex.
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (end === start) {
          // Avoid infinite loop on zero-width matches.
          re.lastIndex = start + 1;
          continue;
        }
        hits.push({ node: current as Text, start, end });
        if (hits.length >= MAX) break;
      }
      if (hits.length >= MAX) break;
      current = walker.nextNode();
    }

    // Splice marks into the DOM in REVERSE order per node so earlier offsets stay valid.
    // Group hits by node first.
    const byNode = new Map<Text, Array<{ start: number; end: number }>>();
    for (const h of hits) {
      const arr = byNode.get(h.node) ?? [];
      arr.push({ start: h.start, end: h.end });
      byNode.set(h.node, arr);
    }

    const marksInOrder: HTMLElement[] = [];
    for (const [node, ranges] of byNode) {
      if (!node.parentNode) continue;
      // Sort ascending; we'll splice from end to start so indexes don't shift.
      ranges.sort((a, b) => a.start - b.start);
      const parent = node.parentNode;
      const frag = document.createDocumentFragment();
      let cursor = 0;
      const markEls: HTMLElement[] = [];
      for (const r of ranges) {
        if (r.start > cursor) {
          frag.appendChild(document.createTextNode(node.nodeValue!.slice(cursor, r.start)));
        }
        const mark = document.createElement("mark");
        mark.dataset.paneSearch = "";
        mark.textContent = node.nodeValue!.slice(r.start, r.end);
        // Inactive match styling (the one pointed at by activeIdx gets restyled below).
        mark.style.backgroundColor = "#264f78";
        mark.style.color = "#fff";
        mark.style.padding = "0";
        mark.style.borderRadius = "2px";
        frag.appendChild(mark);
        markEls.push(mark);
        cursor = r.end;
      }
      if (cursor < (node.nodeValue ?? "").length) {
        frag.appendChild(document.createTextNode(node.nodeValue!.slice(cursor)));
      }
      parent.replaceChild(frag, node);
      marksInOrder.push(...markEls);
    }

    marksRef.current = marksInOrder;
    if (marksInOrder.length === 0) {
      setMatchInfo({ index: 0, count: 0 });
      return;
    }
    activeIdxRef.current = 0;
    highlightActive();
    setMatchInfo({ index: 0, count: marksInOrder.length });
  }, [query, caseSensitive, regex, wholeWord, containerRef]);

  const highlightActive = () => {
    const marks = marksRef.current;
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      if (i === activeIdxRef.current) {
        m.style.backgroundColor = "#39d353";
        m.style.color = "#000";
      } else {
        m.style.backgroundColor = "#264f78";
        m.style.color = "#fff";
      }
    }
    const active = marks[activeIdxRef.current];
    if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  // Re-run with debounce when query/flags change.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runSearch();
    }, 80);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [runSearch]);

  // Clean up marks on unmount.
  useEffect(() => {
    return () => {
      clearMarks();
      normalizeContainer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onNext = useCallback(() => {
    const marks = marksRef.current;
    if (marks.length === 0) return;
    activeIdxRef.current = (activeIdxRef.current + 1) % marks.length;
    highlightActive();
    setMatchInfo({ index: activeIdxRef.current, count: marks.length });
  }, []);

  const onPrev = useCallback(() => {
    const marks = marksRef.current;
    if (marks.length === 0) return;
    activeIdxRef.current = (activeIdxRef.current - 1 + marks.length) % marks.length;
    highlightActive();
    setMatchInfo({ index: activeIdxRef.current, count: marks.length });
  }, []);

  const reset = useCallback(() => {
    setQuery("");
    setMatchInfo(null);
    clearMarks();
    normalizeContainer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    query,
    setQuery,
    caseSensitive,
    setCaseSensitive,
    regex,
    setRegex,
    wholeWord,
    setWholeWord,
    matchInfo,
    onNext,
    onPrev,
    reset,
  };
}

/**
 * Drives @codemirror/search against a CodeMirror EditorView ref and returns
 * PaneSearchBar-compatible state. Requires the `search()` extension to be
 * present in the view's state; we never open CodeMirror's default panel.
 */
export function useCodeMirrorSearch(
  viewRef: React.MutableRefObject<EditorView | null>,
): PaneSearchState {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matchInfo, setMatchInfo] = useState<{ index: number; count: number } | null>(null);
  // Track the previous query we pushed into the view so we can wipe it on reset/unmount.
  const lastPushedRef = useRef<string>("");

  // Build a SearchQuery and push it into the view. Compute match count and index.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    if (!query) {
      view.dispatch({
        effects: setSearchQuery.of(
          new SearchQuery({ search: "", caseSensitive, regexp: regex, wholeWord }),
        ),
      });
      lastPushedRef.current = "";
      setMatchInfo(null);
      return;
    }

    const sq = new SearchQuery({
      search: query,
      caseSensitive,
      regexp: regex,
      wholeWord,
    });
    if (!sq.valid) {
      setMatchInfo({ index: 0, count: 0 });
      return;
    }
    view.dispatch({ effects: setSearchQuery.of(sq) });
    lastPushedRef.current = query;

    // Count matches and find the one nearest the current cursor.
    const doc = view.state.doc;
    const anchor = view.state.selection.main.from;
    let count = 0;
    let index = 0;
    let foundIndex = false;
    try {
      const cursor = sq.getCursor(doc) as Iterator<{ from: number; to: number }>;
      let step = cursor.next();
      while (!step.done) {
        const m = step.value;
        if (!foundIndex && m.from >= anchor) {
          index = count;
          foundIndex = true;
        }
        count++;
        if (count >= 10000) break;
        step = cursor.next();
      }
      if (!foundIndex && count > 0) index = 0;
    } catch {
      // Invalid regex etc.
      setMatchInfo({ index: 0, count: 0 });
      return;
    }
    setMatchInfo({ index, count });
  }, [query, caseSensitive, regex, wholeWord, viewRef]);

  const refreshIndex = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const sq = getSearchQuery(view.state);
    if (!sq || !sq.search) return;
    const doc = view.state.doc;
    const anchor = view.state.selection.main.from;
    let count = 0;
    let index = 0;
    let foundIndex = false;
    try {
      const cursor = sq.getCursor(doc) as Iterator<{ from: number; to: number }>;
      let step = cursor.next();
      while (!step.done) {
        const m = step.value;
        if (!foundIndex && m.from >= anchor) {
          index = count;
          foundIndex = true;
        }
        count++;
        if (count >= 10000) break;
        step = cursor.next();
      }
      if (!foundIndex && count > 0) index = 0;
    } catch {
      return;
    }
    setMatchInfo({ index, count });
  }, [viewRef]);

  const onNext = useCallback(() => {
    const view = viewRef.current;
    if (!view || !query) return;
    cmFindNext(view);
    refreshIndex();
  }, [query, viewRef, refreshIndex]);

  const onPrev = useCallback(() => {
    const view = viewRef.current;
    if (!view || !query) return;
    cmFindPrevious(view);
    refreshIndex();
  }, [query, viewRef, refreshIndex]);

  const reset = useCallback(() => {
    setQuery("");
    setMatchInfo(null);
    const view = viewRef.current;
    if (view) {
      view.dispatch({
        effects: setSearchQuery.of(
          new SearchQuery({ search: "", caseSensitive, regexp: regex, wholeWord }),
        ),
      });
      lastPushedRef.current = "";
    }
  }, [caseSensitive, regex, wholeWord, viewRef]);

  return {
    query,
    setQuery,
    caseSensitive,
    setCaseSensitive,
    regex,
    setRegex,
    wholeWord,
    setWholeWord,
    matchInfo,
    onNext,
    onPrev,
    reset,
  };
}

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  createDeck,
  shuffleDeck,
  rankValue,
  canStackTableau,
  canStackFoundation,
  suitColor,
  type Card,
  type Suit,
  type Rank,
} from "../../lib/card-utils";

// ─── Types ──────────────────────────────────────────────────────────

type SolitaireVariant = "klondike" | "spider" | "freecell" | "pyramid";
type SpiderSuits = 1 | 2 | 4;

interface SolitaireGameProps {
  onAddTimedHighscore: (
    game: "solitaireKlondike" | "solitaireSpider" | "solitaireFreecell",
    seconds: number,
  ) => void;
  onAddHighscore: (score: number) => void;
  paused?: boolean;
}

interface Selection {
  source: "tableau" | "waste" | "freecell" | "pyramid" | "foundation";
  colIdx: number;
  cardIdx: number;
}

interface MoveRecord {
  type: string;
  data: unknown;
}

// ─── Klondike State ─────────────────────────────────────────────────

interface KlondikeState {
  tableau: Card[][];
  stock: Card[];
  waste: Card[];
  foundations: (Card | null)[];
}

// ─── Spider State ───────────────────────────────────────────────────

interface SpiderState {
  tableau: Card[][];
  stock: Card[];
  completedSuits: number;
  suitCount: SpiderSuits;
}

// ─── FreeCell State ─────────────────────────────────────────────────

interface FreeCellState {
  tableau: Card[][];
  freeCells: (Card | null)[];
  foundations: (Card | null)[];
}

// ─── Pyramid State ──────────────────────────────────────────────────

interface PyramidState {
  pyramid: (Card | null)[];
  stock: Card[];
  waste: Card[];
  score: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Suit SVG Icon ──────────────────────────────────────────────────

function SuitIcon({ suit, size = 10 }: { suit: Suit; size?: number }) {
  const paths: Record<Suit, string> = {
    spades:
      "M6 1 C6 1 1 5 1 7.5 C1 9.5 3 11 6 8.5 C6 8.5 5 11 4 11 L8 11 C7 11 6 8.5 6 8.5 C9 11 11 9.5 11 7.5 C11 5 6 1 6 1Z",
    hearts:
      "M6 10.5 C6 10.5 1 7 1 4.5 C1 2.5 3 1 4.5 1 C5.3 1 6 1.8 6 2.5 C6 1.8 6.7 1 7.5 1 C9 1 11 2.5 11 4.5 C11 7 6 10.5 6 10.5Z",
    diamonds: "M6 1 L10.5 6 L6 11 L1.5 6 Z",
    clubs:
      "M6 1.5 C4.5 1.5 3.5 2.5 3.5 3.8 C3.5 5 4.5 5.5 4.5 5.5 C2.5 5 1.5 6 1.5 7.2 C1.5 8.5 2.8 9.5 4.2 9.5 C5.2 9.5 5.8 9 6 8.5 C5.5 10 4.5 11 4 11 L8 11 C7.5 11 6.5 10 6 8.5 C6.2 9 6.8 9.5 7.8 9.5 C9.2 9.5 10.5 8.5 10.5 7.2 C10.5 6 9.5 5 7.5 5.5 C7.5 5.5 8.5 5 8.5 3.8 C8.5 2.5 7.5 1.5 6 1.5Z",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill={suitColor(suit)}>
      <path d={paths[suit]} />
    </svg>
  );
}

// ─── Card Component ─────────────────────────────────────────────────

interface CardViewProps {
  card: Card | null;
  width: number;
  height: number;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  empty?: boolean;
  style?: React.CSSProperties;
}

function CardView({
  card,
  width,
  height,
  selected = false,
  onClick,
  onDoubleClick,
  empty = false,
  style,
}: CardViewProps) {
  if (!card && !empty) return null;

  if (!card && empty) {
    return (
      <div
        onClick={onClick}
        style={{
          width,
          height,
          borderRadius: Math.max(3, width * 0.06),
          border: "1px solid var(--ezy-border)",
          opacity: 0.4,
          boxSizing: "border-box",
          flexShrink: 0,
          ...style,
        }}
      />
    );
  }

  if (!card) return null;

  if (!card.faceUp) {
    return (
      <div
        onClick={onClick}
        style={{
          width,
          height,
          borderRadius: Math.max(3, width * 0.06),
          backgroundColor: "var(--ezy-surface)",
          border: "1px solid var(--ezy-border)",
          cursor: onClick ? "pointer" : "default",
          boxSizing: "border-box",
          flexShrink: 0,
          position: "relative",
          overflow: "hidden",
          ...style,
        }}
      >
        {/* Card back pattern — dot grid */}
        <svg
          width={width - 2}
          height={height - 2}
          style={{ position: "absolute", top: 1, left: 1, opacity: 0.18 }}
        >
          {Array.from({ length: Math.floor((width - 2) / 6) }).map((_, xi) =>
            Array.from({ length: Math.floor((height - 2) / 6) }).map((_, yi) => (
              <circle
                key={`${xi}-${yi}`}
                cx={xi * 6 + 3}
                cy={yi * 6 + 3}
                r={1}
                fill="var(--ezy-text-muted)"
              />
            )),
          )}
        </svg>
      </div>
    );
  }

  const color = suitColor(card.suit);
  const fontSize = Math.max(8, Math.floor(width * 0.24));
  const suitSize = Math.max(6, Math.floor(width * 0.18));

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{
        width,
        height,
        borderRadius: Math.max(3, width * 0.06),
        backgroundColor: "var(--ezy-surface-raised)",
        border: "1px solid var(--ezy-border)",
        outline: selected ? "2px solid var(--ezy-accent)" : "none",
        outlineOffset: -1,
        cursor: onClick ? "pointer" : "default",
        boxSizing: "border-box",
        flexShrink: 0,
        position: "relative",
        userSelect: "none",
        ...style,
      }}
    >
      {/* Top-left rank + suit */}
      <div
        style={{
          position: "absolute",
          top: 2,
          left: 3,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 0,
          lineHeight: 1,
        }}
      >
        <span
          style={{
            fontSize,
            fontWeight: 700,
            color,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          {card.rank}
        </span>
        <SuitIcon suit={card.suit} size={suitSize} />
      </div>
      {/* Center suit (larger cards only) */}
      {width >= 44 && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
          }}
        >
          <SuitIcon suit={card.suit} size={Math.floor(width * 0.38)} />
        </div>
      )}
    </div>
  );
}

// ─── Klondike Game ──────────────────────────────────────────────────

function initKlondike(): KlondikeState {
  const deck = shuffleDeck(createDeck());
  const tableau: Card[][] = [];
  let idx = 0;
  for (let i = 0; i < 7; i++) {
    const col: Card[] = [];
    for (let j = 0; j <= i; j++) {
      const c = { ...deck[idx++] };
      c.faceUp = j === i;
      col.push(c);
    }
    tableau.push(col);
  }
  const stock = deck.slice(idx).map((c) => ({ ...c, faceUp: false }));
  return { tableau, stock, waste: [], foundations: [null, null, null, null] };
}

function KlondikeGame({
  cardWidth,
  cardHeight,
  overlapY,
  onWin,
  paused,
}: {
  cardWidth: number;
  cardHeight: number;
  overlapY: number;
  onWin: () => void;
  paused: boolean;
}) {
  const stateRef = useRef<KlondikeState>(initKlondike());
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);
  const [selection, setSelection] = useState<Selection | null>(null);
  const undoStack = useRef<MoveRecord[]>([]);

  const state = stateRef.current;

  const checkWin = useCallback(() => {
    return state.foundations.every((f) => f !== null && f.rank === "K");
  }, [state]);

  const pushUndo = useCallback((rec: MoveRecord) => {
    undoStack.current.push(rec);
    if (undoStack.current.length > 100) undoStack.current.shift();
  }, []);

  const autoFlipTableau = useCallback(() => {
    let flipped = false;
    for (const col of state.tableau) {
      if (col.length > 0 && !col[col.length - 1].faceUp) {
        col[col.length - 1].faceUp = true;
        flipped = true;
      }
    }
    return flipped;
  }, [state]);

  const tryAutoMoveToFoundation = useCallback(
    (card: Card): number => {
      for (let fi = 0; fi < 4; fi++) {
        if (canStackFoundation(card, state.foundations[fi])) return fi;
      }
      return -1;
    },
    [state],
  );

  const handleStockClick = useCallback(() => {
    if (paused) return;
    setSelection(null);
    if (state.stock.length === 0) {
      // Recycle waste back to stock
      pushUndo({ type: "recycle", data: { wasteLen: state.waste.length } });
      state.stock = state.waste.reverse().map((c) => ({ ...c, faceUp: false }));
      state.waste = [];
    } else {
      const card = state.stock.pop()!;
      card.faceUp = true;
      state.waste.push(card);
      pushUndo({ type: "draw", data: {} });
    }
    rerender();
  }, [state, paused, rerender, pushUndo]);

  const handleClick = useCallback(
    (source: Selection["source"], colIdx: number, cardIdx: number) => {
      if (paused) return;

      // If nothing selected, select this card
      if (!selection) {
        // Can't select face-down cards (except stock)
        if (source === "tableau") {
          const col = state.tableau[colIdx];
          if (cardIdx >= 0 && cardIdx < col.length && col[cardIdx].faceUp) {
            setSelection({ source, colIdx, cardIdx });
          }
        } else if (source === "waste") {
          if (state.waste.length > 0) {
            setSelection({ source, colIdx: 0, cardIdx: state.waste.length - 1 });
          }
        }
        return;
      }

      // Deselect if clicking same selection
      if (
        selection.source === source &&
        selection.colIdx === colIdx &&
        (source !== "tableau" || selection.cardIdx === cardIdx)
      ) {
        setSelection(null);
        return;
      }

      // Try to move
      const getSelectedCards = (): Card[] | null => {
        if (selection.source === "tableau") {
          const col = state.tableau[selection.colIdx];
          return col.slice(selection.cardIdx);
        }
        if (selection.source === "waste") {
          return state.waste.length > 0 ? [state.waste[state.waste.length - 1]] : null;
        }
        return null;
      };

      const cards = getSelectedCards();
      if (!cards || cards.length === 0) {
        setSelection(null);
        return;
      }

      const topCard = cards[0];

      if (source === "foundation") {
        // Only single card to foundation
        if (cards.length !== 1) {
          setSelection(null);
          return;
        }
        if (canStackFoundation(topCard, state.foundations[colIdx])) {
          // Remove from source
          if (selection.source === "tableau") {
            state.tableau[selection.colIdx].pop();
          } else if (selection.source === "waste") {
            state.waste.pop();
          }
          pushUndo({
            type: "toFoundation",
            data: { from: selection.source, fromCol: selection.colIdx, fi: colIdx },
          });
          state.foundations[colIdx] = topCard;
          autoFlipTableau();
          setSelection(null);
          rerender();
          if (checkWin()) onWin();
          return;
        }
      }

      if (source === "tableau") {
        const targetCol = state.tableau[colIdx];
        let canMove = false;
        if (targetCol.length === 0) {
          canMove = topCard.rank === "K";
        } else {
          canMove = canStackTableau(topCard, targetCol[targetCol.length - 1]);
        }
        if (canMove) {
          if (selection.source === "tableau") {
            const removed = state.tableau[selection.colIdx].splice(selection.cardIdx);
            state.tableau[colIdx].push(...removed);
            pushUndo({
              type: "moveTableau",
              data: {
                from: selection.colIdx,
                to: colIdx,
                count: removed.length,
                fromIdx: selection.cardIdx,
              },
            });
          } else if (selection.source === "waste") {
            const card = state.waste.pop()!;
            state.tableau[colIdx].push(card);
            pushUndo({ type: "wasteToTableau", data: { to: colIdx } });
          }
          autoFlipTableau();
          setSelection(null);
          rerender();
          if (checkWin()) onWin();
          return;
        }
      }

      // Invalid move — just reselect
      if (source === "tableau") {
        const col = state.tableau[colIdx];
        if (cardIdx >= 0 && cardIdx < col.length && col[cardIdx].faceUp) {
          setSelection({ source, colIdx, cardIdx });
        } else {
          setSelection(null);
        }
      } else {
        setSelection(null);
      }
    },
    [selection, state, paused, rerender, autoFlipTableau, checkWin, onWin, pushUndo],
  );

  const handleDoubleClick = useCallback(
    (source: Selection["source"], colIdx: number) => {
      if (paused) return;
      let card: Card | null = null;
      if (source === "tableau") {
        const col = state.tableau[colIdx];
        if (col.length > 0) card = col[col.length - 1];
      } else if (source === "waste") {
        if (state.waste.length > 0) card = state.waste[state.waste.length - 1];
      }
      if (!card) return;
      const fi = tryAutoMoveToFoundation(card);
      if (fi >= 0) {
        if (source === "tableau") {
          state.tableau[colIdx].pop();
        } else if (source === "waste") {
          state.waste.pop();
        }
        pushUndo({
          type: "toFoundation",
          data: { from: source, fromCol: colIdx, fi },
        });
        state.foundations[fi] = card;
        autoFlipTableau();
        setSelection(null);
        rerender();
        if (checkWin()) onWin();
      }
    },
    [state, paused, tryAutoMoveToFoundation, autoFlipTableau, rerender, checkWin, onWin, pushUndo],
  );

  const handleUndo = useCallback(() => {
    const rec = undoStack.current.pop();
    if (!rec) return;
    const d = rec.data as Record<string, unknown>;
    switch (rec.type) {
      case "draw": {
        const card = state.waste.pop()!;
        card.faceUp = false;
        state.stock.push(card);
        break;
      }
      case "recycle": {
        const wasteLen = d.wasteLen as number;
        const cards = state.stock.splice(0).reverse();
        for (const c of cards) c.faceUp = true;
        state.waste = cards.slice(0, wasteLen);
        break;
      }
      case "toFoundation": {
        const fi = d.fi as number;
        const from = d.from as string;
        const fromCol = d.fromCol as number;
        const card = state.foundations[fi]!;
        // Restore foundation to previous card
        const prevRank = rankValue(card.rank) - 1;
        if (prevRank === 0) {
          state.foundations[fi] = null;
        } else {
          const ranks: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
          state.foundations[fi] = { suit: card.suit, rank: ranks[prevRank - 1], faceUp: true, id: `${card.suit}-${ranks[prevRank - 1]}` };
        }
        if (from === "tableau") {
          state.tableau[fromCol].push(card);
        } else if (from === "waste") {
          state.waste.push(card);
        }
        break;
      }
      case "moveTableau": {
        const from = d.from as number;
        const to = d.to as number;
        const count = d.count as number;
        const cards = state.tableau[to].splice(state.tableau[to].length - count);
        state.tableau[from].push(...cards);
        // Un-flip the card that was revealed
        if (state.tableau[from].length > cards.length) {
          const underCard = state.tableau[from][state.tableau[from].length - cards.length - 1];
          if (underCard.faceUp) {
            // Only un-flip if it was auto-flipped (approximation)
            // We can't know for sure, so leave it
          }
        }
        break;
      }
      case "wasteToTableau": {
        const to = d.to as number;
        const card = state.tableau[to].pop()!;
        state.waste.push(card);
        break;
      }
    }
    setSelection(null);
    rerender();
  }, [state, rerender]);

  const gap = Math.max(2, Math.floor(cardWidth * 0.08));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 6, width: "100%", alignItems: "center" }}>
      {/* Top row: stock, waste, gap, foundations */}
      <div style={{ display: "flex", gap, alignItems: "flex-start", width: "100%", justifyContent: "center" }}>
        {/* Stock */}
        <div onClick={handleStockClick} style={{ cursor: "pointer" }}>
          {state.stock.length > 0 ? (
            <CardView card={{ ...state.stock[state.stock.length - 1], faceUp: false } as Card} width={cardWidth} height={cardHeight} onClick={handleStockClick} />
          ) : (
            <CardView card={null} width={cardWidth} height={cardHeight} empty onClick={handleStockClick} />
          )}
        </div>
        {/* Waste */}
        <div>
          {state.waste.length > 0 ? (
            <CardView
              card={state.waste[state.waste.length - 1]}
              width={cardWidth}
              height={cardHeight}
              selected={selection?.source === "waste"}
              onClick={() => handleClick("waste", 0, state.waste.length - 1)}
              onDoubleClick={() => handleDoubleClick("waste", 0)}
            />
          ) : (
            <CardView card={null} width={cardWidth} height={cardHeight} empty />
          )}
        </div>
        {/* Spacer */}
        <div style={{ width: cardWidth }} />
        {/* Foundations */}
        {state.foundations.map((f, fi) => (
          <div key={fi}>
            {f ? (
              <CardView
                card={f}
                width={cardWidth}
                height={cardHeight}
                onClick={() => handleClick("foundation", fi, 0)}
              />
            ) : (
              <CardView
                card={null}
                width={cardWidth}
                height={cardHeight}
                empty
                onClick={() => handleClick("foundation", fi, 0)}
              />
            )}
          </div>
        ))}
      </div>

      {/* Tableau */}
      <div style={{ display: "flex", gap, justifyContent: "center", width: "100%", alignItems: "flex-start" }}>
        {state.tableau.map((col, ci) => (
          <div key={ci} style={{ position: "relative", width: cardWidth, minHeight: cardHeight }}>
            {col.length === 0 ? (
              <CardView
                card={null}
                width={cardWidth}
                height={cardHeight}
                empty
                onClick={() => handleClick("tableau", ci, 0)}
              />
            ) : (
              col.map((card, cardIdx) => (
                <div
                  key={card.id}
                  style={{
                    position: cardIdx === 0 ? "relative" : "absolute",
                    top: cardIdx === 0 ? 0 : cardIdx * overlapY,
                    left: 0,
                    zIndex: cardIdx,
                  }}
                >
                  <CardView
                    card={card}
                    width={cardWidth}
                    height={cardHeight}
                    selected={
                      selection?.source === "tableau" &&
                      selection.colIdx === ci &&
                      cardIdx >= selection.cardIdx
                    }
                    onClick={() => handleClick("tableau", ci, cardIdx)}
                    onDoubleClick={
                      cardIdx === col.length - 1 ? () => handleDoubleClick("tableau", ci) : undefined
                    }
                  />
                </div>
              ))
            )}
          </div>
        ))}
      </div>

      {/* Undo button */}
      <button
        onClick={handleUndo}
        disabled={undoStack.current.length === 0}
        style={{
          padding: "4px 14px",
          fontSize: 11,
          fontWeight: 600,
          color: undoStack.current.length > 0 ? "var(--ezy-text-secondary)" : "var(--ezy-text-muted)",
          backgroundColor: "var(--ezy-surface)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 4,
          cursor: undoStack.current.length > 0 ? "pointer" : "default",
          opacity: undoStack.current.length > 0 ? 1 : 0.5,
        }}
      >
        Undo
      </button>
    </div>
  );
}

// ─── Spider Game ────────────────────────────────────────────────────

function buildSpiderDeck(suitCount: SpiderSuits): Card[] {
  const suits: Suit[] =
    suitCount === 1
      ? ["spades"]
      : suitCount === 2
        ? ["spades", "hearts"]
        : ["spades", "hearts", "diamonds", "clubs"];

  const deck: Card[] = [];
  const needed = 104;
  let idx = 0;
  while (deck.length < needed) {
    const suit = suits[idx % suits.length];
    const ranks: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
    for (const rank of ranks) {
      deck.push({
        suit,
        rank,
        faceUp: false,
        id: `${suit}-${rank}-${Math.floor(deck.length / 52)}`,
      });
      if (deck.length >= needed) break;
    }
    idx++;
  }
  return shuffleDeck(deck);
}

function initSpider(suitCount: SpiderSuits): SpiderState {
  const deck = buildSpiderDeck(suitCount);
  const tableau: Card[][] = [];
  let idx = 0;
  for (let i = 0; i < 10; i++) {
    const count = i < 4 ? 6 : 5;
    const col: Card[] = [];
    for (let j = 0; j < count; j++) {
      const c = { ...deck[idx++] };
      c.faceUp = j === count - 1;
      col.push(c);
    }
    tableau.push(col);
  }
  const stock = deck.slice(idx).map((c) => ({ ...c, faceUp: false }));
  return { tableau, stock, completedSuits: 0, suitCount };
}

function SpiderGame({
  cardWidth,
  cardHeight,
  overlapY,
  onWin,
  paused,
  suitCount,
}: {
  cardWidth: number;
  cardHeight: number;
  overlapY: number;
  onWin: () => void;
  paused: boolean;
  suitCount: SpiderSuits;
}) {
  const stateRef = useRef<SpiderState>(initSpider(suitCount));
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);
  const [selection, setSelection] = useState<Selection | null>(null);
  const undoStack = useRef<MoveRecord[]>([]);

  const state = stateRef.current;

  // Check and remove complete K->A same-suit sequences
  const checkCompleteSequences = useCallback(() => {
    let removed = false;
    for (const col of state.tableau) {
      if (col.length < 13) continue;
      // Check last 13 cards for same-suit K->A
      const start = col.length - 13;
      const suit = col[start].suit;
      let valid = true;
      for (let i = 0; i < 13; i++) {
        const card = col[start + i];
        if (!card.faceUp || card.suit !== suit || rankValue(card.rank) !== 13 - i) {
          valid = false;
          break;
        }
      }
      if (valid) {
        col.splice(start, 13);
        state.completedSuits++;
        removed = true;
        // Flip new top card
        if (col.length > 0 && !col[col.length - 1].faceUp) {
          col[col.length - 1].faceUp = true;
        }
      }
    }
    return removed;
  }, [state]);

  const handleDeal = useCallback(() => {
    if (paused) return;
    if (state.stock.length === 0) return;
    // Can't deal if any column is empty
    if (state.tableau.some((col) => col.length === 0)) return;
    setSelection(null);

    const undoData: { col: number; cardId: string }[] = [];
    for (let i = 0; i < 10 && state.stock.length > 0; i++) {
      const card = state.stock.pop()!;
      card.faceUp = true;
      state.tableau[i].push(card);
      undoData.push({ col: i, cardId: card.id });
    }
    undoStack.current.push({ type: "deal", data: undoData });
    checkCompleteSequences();
    rerender();
    if (state.completedSuits >= 8) onWin();
  }, [state, paused, rerender, checkCompleteSequences, onWin]);

  const handleClick = useCallback(
    (colIdx: number, cardIdx: number) => {
      if (paused) return;
      const col = state.tableau[colIdx];
      if (cardIdx < 0 || cardIdx >= col.length || !col[cardIdx].faceUp) return;

      // Check if cards from cardIdx down are a valid same-suit descending sequence
      const movingCards = col.slice(cardIdx);
      let validSeq = true;
      for (let i = 1; i < movingCards.length; i++) {
        if (
          movingCards[i].suit !== movingCards[0].suit ||
          rankValue(movingCards[i].rank) !== rankValue(movingCards[i - 1].rank) - 1
        ) {
          validSeq = false;
          break;
        }
      }

      if (!selection) {
        if (validSeq) {
          setSelection({ source: "tableau", colIdx, cardIdx });
        }
        return;
      }

      // Deselect if same
      if (selection.colIdx === colIdx && selection.cardIdx === cardIdx) {
        setSelection(null);
        return;
      }

      // Try to move
      const srcCol = state.tableau[selection.colIdx];
      const cards = srcCol.slice(selection.cardIdx);
      const topCard = cards[0];

      if (col.length === 0 || rankValue(col[col.length - 1].rank) === rankValue(topCard.rank) + 1) {
        const removed = srcCol.splice(selection.cardIdx);
        state.tableau[colIdx].push(...removed);
        undoStack.current.push({
          type: "move",
          data: { from: selection.colIdx, to: colIdx, count: removed.length, fromIdx: selection.cardIdx },
        });
        // Flip
        if (srcCol.length > 0 && !srcCol[srcCol.length - 1].faceUp) {
          srcCol[srcCol.length - 1].faceUp = true;
        }
        checkCompleteSequences();
        setSelection(null);
        rerender();
        if (state.completedSuits >= 8) onWin();
        return;
      }

      // Invalid — reselect
      if (validSeq) {
        setSelection({ source: "tableau", colIdx, cardIdx });
      } else {
        setSelection(null);
      }
    },
    [selection, state, paused, rerender, checkCompleteSequences, onWin],
  );

  const handleEmptyColClick = useCallback(
    (colIdx: number) => {
      if (paused || !selection) return;
      const srcCol = state.tableau[selection.colIdx];
      const removed = srcCol.splice(selection.cardIdx);
      state.tableau[colIdx].push(...removed);
      undoStack.current.push({
        type: "move",
        data: { from: selection.colIdx, to: colIdx, count: removed.length, fromIdx: selection.cardIdx },
      });
      if (srcCol.length > 0 && !srcCol[srcCol.length - 1].faceUp) {
        srcCol[srcCol.length - 1].faceUp = true;
      }
      setSelection(null);
      rerender();
    },
    [selection, state, paused, rerender],
  );

  const handleUndo = useCallback(() => {
    const rec = undoStack.current.pop();
    if (!rec) return;
    const d = rec.data as Record<string, unknown>;
    if (rec.type === "move") {
      const from = d.from as number;
      const to = d.to as number;
      const count = d.count as number;
      const cards = state.tableau[to].splice(state.tableau[to].length - count);
      state.tableau[from].push(...cards);
    }
    setSelection(null);
    rerender();
  }, [state, rerender]);

  const gap = Math.max(2, Math.floor(cardWidth * 0.06));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 6, width: "100%", alignItems: "center" }}>
      {/* Info row */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "center", width: "100%" }}>
        <span style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>
          Completed: <span style={{ color: "var(--ezy-accent)" }}>{state.completedSuits}/8</span>
        </span>
        <span style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>
          Stock: {Math.ceil(state.stock.length / 10)} deals
        </span>
        {state.stock.length > 0 && (
          <button
            onClick={handleDeal}
            disabled={state.tableau.some((col) => col.length === 0)}
            style={{
              padding: "3px 10px",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ezy-text-secondary)",
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 4,
              cursor: state.tableau.some((col) => col.length === 0) ? "default" : "pointer",
              opacity: state.tableau.some((col) => col.length === 0) ? 0.5 : 1,
            }}
          >
            Deal
          </button>
        )}
      </div>

      {/* Tableau */}
      <div style={{ display: "flex", gap, justifyContent: "center", width: "100%", alignItems: "flex-start" }}>
        {state.tableau.map((col, ci) => (
          <div key={ci} style={{ position: "relative", width: cardWidth, minHeight: cardHeight }}>
            {col.length === 0 ? (
              <CardView
                card={null}
                width={cardWidth}
                height={cardHeight}
                empty
                onClick={() => handleEmptyColClick(ci)}
              />
            ) : (
              col.map((card, cardIdx) => (
                <div
                  key={card.id}
                  style={{
                    position: cardIdx === 0 ? "relative" : "absolute",
                    top: cardIdx === 0 ? 0 : cardIdx * overlapY,
                    left: 0,
                    zIndex: cardIdx,
                  }}
                >
                  <CardView
                    card={card}
                    width={cardWidth}
                    height={cardHeight}
                    selected={
                      selection?.source === "tableau" &&
                      selection.colIdx === ci &&
                      cardIdx >= selection.cardIdx
                    }
                    onClick={() => handleClick(ci, cardIdx)}
                  />
                </div>
              ))
            )}
          </div>
        ))}
      </div>

      <button
        onClick={handleUndo}
        disabled={undoStack.current.length === 0}
        style={{
          padding: "4px 14px",
          fontSize: 11,
          fontWeight: 600,
          color: undoStack.current.length > 0 ? "var(--ezy-text-secondary)" : "var(--ezy-text-muted)",
          backgroundColor: "var(--ezy-surface)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 4,
          cursor: undoStack.current.length > 0 ? "pointer" : "default",
          opacity: undoStack.current.length > 0 ? 1 : 0.5,
        }}
      >
        Undo
      </button>
    </div>
  );
}

// ─── FreeCell Game ──────────────────────────────────────────────────

function initFreeCell(): FreeCellState {
  const deck = shuffleDeck(createDeck());
  const tableau: Card[][] = Array.from({ length: 8 }, () => []);
  for (let i = 0; i < 52; i++) {
    const card = { ...deck[i], faceUp: true };
    tableau[i % 8].push(card);
  }
  return {
    tableau,
    freeCells: [null, null, null, null],
    foundations: [null, null, null, null],
  };
}

function FreeCellGame({
  cardWidth,
  cardHeight,
  overlapY,
  onWin,
  paused,
}: {
  cardWidth: number;
  cardHeight: number;
  overlapY: number;
  onWin: () => void;
  paused: boolean;
}) {
  const stateRef = useRef<FreeCellState>(initFreeCell());
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);
  const [selection, setSelection] = useState<Selection | null>(null);
  const undoStack = useRef<MoveRecord[]>([]);

  const state = stateRef.current;

  const emptyFreeCells = useMemo(() => state.freeCells.filter((c) => c === null).length, [state.freeCells]);
  const emptyColumns = useMemo(() => state.tableau.filter((col) => col.length === 0).length, [state.tableau]);
  const maxMovable = (emptyFreeCells + 1) * Math.pow(2, emptyColumns);

  const checkWin = useCallback(() => {
    return state.foundations.every((f) => f !== null && f.rank === "K");
  }, [state]);

  const tryAutoMoveToFoundation = useCallback(
    (card: Card): number => {
      for (let fi = 0; fi < 4; fi++) {
        if (canStackFoundation(card, state.foundations[fi])) return fi;
      }
      return -1;
    },
    [state],
  );

  const handleClick = useCallback(
    (source: Selection["source"], colIdx: number, cardIdx: number) => {
      if (paused) return;

      if (!selection) {
        if (source === "tableau") {
          const col = state.tableau[colIdx];
          if (cardIdx >= 0 && cardIdx < col.length) {
            setSelection({ source, colIdx, cardIdx });
          }
        } else if (source === "freecell") {
          if (state.freeCells[colIdx] !== null) {
            setSelection({ source, colIdx, cardIdx: 0 });
          }
        }
        return;
      }

      // Deselect if same
      if (selection.source === source && selection.colIdx === colIdx) {
        setSelection(null);
        return;
      }

      // Get selected cards
      const getSelectedCards = (): Card[] | null => {
        if (selection.source === "tableau") {
          return state.tableau[selection.colIdx].slice(selection.cardIdx);
        }
        if (selection.source === "freecell") {
          const c = state.freeCells[selection.colIdx];
          return c ? [c] : null;
        }
        return null;
      };

      const cards = getSelectedCards();
      if (!cards || cards.length === 0) {
        setSelection(null);
        return;
      }

      const topCard = cards[0];

      // Move to foundation
      if (source === "foundation") {
        if (cards.length === 1 && canStackFoundation(topCard, state.foundations[colIdx])) {
          if (selection.source === "tableau") {
            state.tableau[selection.colIdx].pop();
          } else if (selection.source === "freecell") {
            state.freeCells[selection.colIdx] = null;
          }
          undoStack.current.push({
            type: "toFoundation",
            data: { from: selection.source, fromCol: selection.colIdx, fi: colIdx },
          });
          state.foundations[colIdx] = topCard;
          setSelection(null);
          rerender();
          if (checkWin()) onWin();
          return;
        }
        setSelection(null);
        return;
      }

      // Move to free cell
      if (source === "freecell") {
        if (cards.length === 1 && state.freeCells[colIdx] === null) {
          if (selection.source === "tableau") {
            state.tableau[selection.colIdx].pop();
          } else if (selection.source === "freecell") {
            state.freeCells[selection.colIdx] = null;
          }
          undoStack.current.push({
            type: "toFreeCell",
            data: { from: selection.source, fromCol: selection.colIdx, fc: colIdx },
          });
          state.freeCells[colIdx] = topCard;
          setSelection(null);
          rerender();
          return;
        }
        // Try to reselect
        if (state.freeCells[colIdx] !== null) {
          setSelection({ source: "freecell", colIdx, cardIdx: 0 });
        } else {
          setSelection(null);
        }
        return;
      }

      // Move to tableau
      if (source === "tableau") {
        const targetCol = state.tableau[colIdx];
        // Check move limit
        if (cards.length > maxMovable) {
          setSelection(null);
          return;
        }

        // Check valid sequence in cards being moved
        let validSeq = true;
        for (let i = 1; i < cards.length; i++) {
          if (!canStackTableau(cards[i], cards[i - 1])) {
            validSeq = false;
            break;
          }
        }
        if (!validSeq) {
          setSelection(null);
          return;
        }

        let canMove = false;
        if (targetCol.length === 0) {
          canMove = true;
        } else {
          canMove = canStackTableau(topCard, targetCol[targetCol.length - 1]);
        }

        if (canMove) {
          if (selection.source === "tableau") {
            const removed = state.tableau[selection.colIdx].splice(selection.cardIdx);
            state.tableau[colIdx].push(...removed);
          } else if (selection.source === "freecell") {
            const card = state.freeCells[selection.colIdx]!;
            state.freeCells[selection.colIdx] = null;
            state.tableau[colIdx].push(card);
          }
          undoStack.current.push({
            type: "moveTableau",
            data: {
              from: selection.source,
              fromCol: selection.colIdx,
              to: colIdx,
              count: cards.length,
              fromIdx: selection.cardIdx,
            },
          });
          setSelection(null);
          rerender();
          if (checkWin()) onWin();
          return;
        }

        // Reselect
        if (cardIdx >= 0 && cardIdx < targetCol.length) {
          setSelection({ source: "tableau", colIdx, cardIdx });
        } else {
          setSelection(null);
        }
      }
    },
    [selection, state, paused, maxMovable, rerender, checkWin, onWin],
  );

  const handleDoubleClick = useCallback(
    (source: Selection["source"], colIdx: number) => {
      if (paused) return;
      let card: Card | null = null;
      if (source === "tableau") {
        const col = state.tableau[colIdx];
        if (col.length > 0) card = col[col.length - 1];
      } else if (source === "freecell") {
        card = state.freeCells[colIdx];
      }
      if (!card) return;
      const fi = tryAutoMoveToFoundation(card);
      if (fi >= 0) {
        if (source === "tableau") {
          state.tableau[colIdx].pop();
        } else if (source === "freecell") {
          state.freeCells[colIdx] = null;
        }
        undoStack.current.push({
          type: "toFoundation",
          data: { from: source, fromCol: colIdx, fi },
        });
        state.foundations[fi] = card;
        setSelection(null);
        rerender();
        if (checkWin()) onWin();
      }
    },
    [state, paused, tryAutoMoveToFoundation, rerender, checkWin, onWin],
  );

  const handleUndo = useCallback(() => {
    const rec = undoStack.current.pop();
    if (!rec) return;
    const d = rec.data as Record<string, unknown>;
    switch (rec.type) {
      case "toFoundation": {
        const fi = d.fi as number;
        const from = d.from as string;
        const fromCol = d.fromCol as number;
        const card = state.foundations[fi]!;
        const prevRank = rankValue(card.rank) - 1;
        if (prevRank === 0) {
          state.foundations[fi] = null;
        } else {
          const ranks: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
          state.foundations[fi] = { suit: card.suit, rank: ranks[prevRank - 1], faceUp: true, id: `${card.suit}-${ranks[prevRank - 1]}` };
        }
        if (from === "tableau") {
          state.tableau[fromCol].push(card);
        } else if (from === "freecell") {
          state.freeCells[fromCol] = card;
        }
        break;
      }
      case "toFreeCell": {
        const from = d.from as string;
        const fromCol = d.fromCol as number;
        const fc = d.fc as number;
        const card = state.freeCells[fc]!;
        state.freeCells[fc] = null;
        if (from === "tableau") {
          state.tableau[fromCol].push(card);
        } else if (from === "freecell") {
          state.freeCells[fromCol] = card;
        }
        break;
      }
      case "moveTableau": {
        const from = d.from as string;
        const fromCol = d.fromCol as number;
        const to = d.to as number;
        const count = d.count as number;
        const cards = state.tableau[to].splice(state.tableau[to].length - count);
        if (from === "tableau") {
          state.tableau[fromCol].push(...cards);
        } else if (from === "freecell") {
          state.freeCells[fromCol] = cards[0];
        }
        break;
      }
    }
    setSelection(null);
    rerender();
  }, [state, rerender]);

  const gap = Math.max(2, Math.floor(cardWidth * 0.08));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 6, width: "100%", alignItems: "center" }}>
      {/* Top row: free cells + foundations */}
      <div style={{ display: "flex", gap, alignItems: "flex-start", width: "100%", justifyContent: "center" }}>
        {/* Free cells */}
        {state.freeCells.map((fc, fi) => (
          <div key={`fc-${fi}`}>
            {fc ? (
              <CardView
                card={fc}
                width={cardWidth}
                height={cardHeight}
                selected={selection?.source === "freecell" && selection.colIdx === fi}
                onClick={() => handleClick("freecell", fi, 0)}
                onDoubleClick={() => handleDoubleClick("freecell", fi)}
              />
            ) : (
              <CardView
                card={null}
                width={cardWidth}
                height={cardHeight}
                empty
                onClick={() => handleClick("freecell", fi, 0)}
              />
            )}
          </div>
        ))}
        {/* Foundations */}
        {state.foundations.map((f, fi) => (
          <div key={`fn-${fi}`}>
            {f ? (
              <CardView
                card={f}
                width={cardWidth}
                height={cardHeight}
                onClick={() => handleClick("foundation", fi, 0)}
              />
            ) : (
              <CardView
                card={null}
                width={cardWidth}
                height={cardHeight}
                empty
                onClick={() => handleClick("foundation", fi, 0)}
              />
            )}
          </div>
        ))}
      </div>

      {/* Tableau */}
      <div style={{ display: "flex", gap, justifyContent: "center", width: "100%", alignItems: "flex-start" }}>
        {state.tableau.map((col, ci) => (
          <div key={ci} style={{ position: "relative", width: cardWidth, minHeight: cardHeight }}>
            {col.length === 0 ? (
              <CardView
                card={null}
                width={cardWidth}
                height={cardHeight}
                empty
                onClick={() => handleClick("tableau", ci, 0)}
              />
            ) : (
              col.map((card, cardIdx) => (
                <div
                  key={card.id}
                  style={{
                    position: cardIdx === 0 ? "relative" : "absolute",
                    top: cardIdx === 0 ? 0 : cardIdx * overlapY,
                    left: 0,
                    zIndex: cardIdx,
                  }}
                >
                  <CardView
                    card={card}
                    width={cardWidth}
                    height={cardHeight}
                    selected={
                      selection?.source === "tableau" &&
                      selection.colIdx === ci &&
                      cardIdx >= selection.cardIdx
                    }
                    onClick={() => handleClick("tableau", ci, cardIdx)}
                    onDoubleClick={
                      cardIdx === col.length - 1 ? () => handleDoubleClick("tableau", ci) : undefined
                    }
                  />
                </div>
              ))
            )}
          </div>
        ))}
      </div>

      {/* Move limit info + undo */}
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>
          Max movable: <span style={{ color: "var(--ezy-accent)" }}>{maxMovable}</span>
        </span>
        <button
          onClick={handleUndo}
          disabled={undoStack.current.length === 0}
          style={{
            padding: "4px 14px",
            fontSize: 11,
            fontWeight: 600,
            color: undoStack.current.length > 0 ? "var(--ezy-text-secondary)" : "var(--ezy-text-muted)",
            backgroundColor: "var(--ezy-surface)",
            border: "1px solid var(--ezy-border)",
            borderRadius: 4,
            cursor: undoStack.current.length > 0 ? "pointer" : "default",
            opacity: undoStack.current.length > 0 ? 1 : 0.5,
          }}
        >
          Undo
        </button>
      </div>
    </div>
  );
}

// ─── Pyramid Game ───────────────────────────────────────────────────

function initPyramid(): PyramidState {
  const deck = shuffleDeck(createDeck());
  // 28 cards in pyramid
  const pyramid: (Card | null)[] = [];
  for (let i = 0; i < 28; i++) {
    pyramid.push({ ...deck[i], faceUp: true });
  }
  const stock = deck.slice(28).map((c) => ({ ...c, faceUp: false }));
  return { pyramid, stock, waste: [], score: 0 };
}

// Pyramid row/col helpers
function pyramidRowCol(index: number): { row: number; col: number } {
  let r = 0;
  let idx = 0;
  while (idx + r + 1 <= index) {
    idx += r + 1;
    r++;
  }
  return { row: r, col: index - idx };
}

function pyramidIndex(row: number, col: number): number {
  return (row * (row + 1)) / 2 + col;
}

function isExposed(pyramid: (Card | null)[], index: number): boolean {
  const { row, col } = pyramidRowCol(index);
  if (row === 6) return true; // Bottom row is always exposed
  // Check children
  const leftChild = pyramidIndex(row + 1, col);
  const rightChild = pyramidIndex(row + 1, col + 1);
  return pyramid[leftChild] === null && pyramid[rightChild] === null;
}

function PyramidGame({
  cardWidth,
  cardHeight,
  onWin,
  onScoreUpdate,
  paused,
}: {
  cardWidth: number;
  cardHeight: number;
  onWin: (score: number) => void;
  onScoreUpdate: (score: number) => void;
  paused: boolean;
}) {
  const stateRef = useRef<PyramidState>(initPyramid());
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);
  const [selection, setSelection] = useState<Selection | null>(null);
  const undoStack = useRef<MoveRecord[]>([]);

  const state = stateRef.current;

  const checkWin = useCallback(() => {
    return state.pyramid.every((c) => c === null);
  }, [state]);

  const handleRemovePair = useCallback(
    (idx1: number, source1: string, idx2: number, source2: string) => {
      let card1: Card | null = null;
      let card2: Card | null = null;

      if (source1 === "pyramid") card1 = state.pyramid[idx1];
      else if (source1 === "waste") card1 = state.waste.length > 0 ? state.waste[state.waste.length - 1] : null;

      if (source2 === "pyramid") card2 = state.pyramid[idx2];
      else if (source2 === "waste") card2 = state.waste.length > 0 ? state.waste[state.waste.length - 1] : null;

      if (!card1 || !card2) return false;
      if (rankValue(card1.rank) + rankValue(card2.rank) !== 13) return false;

      // Remove both
      undoStack.current.push({
        type: "pair",
        data: { idx1, source1, card1: { ...card1 }, idx2, source2, card2: { ...card2 } },
      });

      if (source1 === "pyramid") state.pyramid[idx1] = null;
      else if (source1 === "waste") state.waste.pop();

      if (source2 === "pyramid") state.pyramid[idx2] = null;
      else if (source2 === "waste") state.waste.pop();

      state.score += 10;
      onScoreUpdate(state.score);
      rerender();

      if (checkWin()) onWin(state.score);
      return true;
    },
    [state, rerender, checkWin, onWin, onScoreUpdate],
  );

  const handlePyramidClick = useCallback(
    (index: number) => {
      if (paused) return;
      const card = state.pyramid[index];
      if (!card || !isExposed(state.pyramid, index)) return;

      // King — remove alone
      if (card.rank === "K") {
        undoStack.current.push({
          type: "king",
          data: { index, source: "pyramid", card: { ...card } },
        });
        state.pyramid[index] = null;
        state.score += 10;
        onScoreUpdate(state.score);
        setSelection(null);
        rerender();
        if (checkWin()) onWin(state.score);
        return;
      }

      if (!selection) {
        setSelection({ source: "pyramid", colIdx: index, cardIdx: 0 });
        return;
      }

      // Try to pair with selection
      const selSource = selection.source === "pyramid" ? "pyramid" : "waste";
      const selIdx = selection.colIdx;

      if (selSource === "pyramid" && selIdx === index) {
        setSelection(null);
        return;
      }

      const success = handleRemovePair(selIdx, selSource, index, "pyramid");
      setSelection(success ? null : { source: "pyramid", colIdx: index, cardIdx: 0 });
    },
    [selection, state, paused, rerender, handleRemovePair, checkWin, onWin, onScoreUpdate],
  );

  const handleWasteClick = useCallback(() => {
    if (paused) return;
    if (state.waste.length === 0) return;
    const card = state.waste[state.waste.length - 1];

    // King — remove alone
    if (card.rank === "K") {
      undoStack.current.push({
        type: "king",
        data: { index: state.waste.length - 1, source: "waste", card: { ...card } },
      });
      state.waste.pop();
      state.score += 10;
      onScoreUpdate(state.score);
      setSelection(null);
      rerender();
      return;
    }

    if (!selection) {
      setSelection({ source: "waste", colIdx: state.waste.length - 1, cardIdx: 0 });
      return;
    }

    if (selection.source === "waste") {
      setSelection(null);
      return;
    }

    // Try to pair with selection
    const success = handleRemovePair(
      selection.colIdx,
      selection.source === "pyramid" ? "pyramid" : "waste",
      state.waste.length - 1,
      "waste",
    );
    if (!success) {
      setSelection({ source: "waste", colIdx: state.waste.length - 1, cardIdx: 0 });
    } else {
      setSelection(null);
    }
  }, [selection, state, paused, rerender, handleRemovePair, onScoreUpdate]);

  const handleStockClick = useCallback(() => {
    if (paused) return;
    setSelection(null);
    if (state.stock.length === 0) return;
    const card = state.stock.pop()!;
    card.faceUp = true;
    state.waste.push(card);
    undoStack.current.push({ type: "draw", data: {} });
    rerender();
  }, [state, paused, rerender]);

  const handleUndo = useCallback(() => {
    const rec = undoStack.current.pop();
    if (!rec) return;
    const d = rec.data as Record<string, unknown>;
    switch (rec.type) {
      case "draw": {
        const card = state.waste.pop()!;
        card.faceUp = false;
        state.stock.push(card);
        break;
      }
      case "king": {
        const source = d.source as string;
        const card = d.card as Card;
        const index = d.index as number;
        if (source === "pyramid") {
          state.pyramid[index] = card;
        } else {
          state.waste.push(card);
        }
        state.score -= 10;
        onScoreUpdate(state.score);
        break;
      }
      case "pair": {
        const card1 = d.card1 as Card;
        const card2 = d.card2 as Card;
        const source1 = d.source1 as string;
        const source2 = d.source2 as string;
        const idx1 = d.idx1 as number;
        const idx2 = d.idx2 as number;
        // Restore in reverse order (source2 first since it was removed second)
        if (source2 === "pyramid") state.pyramid[idx2] = card2;
        else state.waste.push(card2);
        if (source1 === "pyramid") state.pyramid[idx1] = card1;
        else state.waste.push(card1);
        state.score -= 10;
        onScoreUpdate(state.score);
        break;
      }
    }
    setSelection(null);
    rerender();
  }, [state, rerender, onScoreUpdate]);

  const gap = Math.max(1, Math.floor(cardWidth * 0.05));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 6, width: "100%", alignItems: "center" }}>
      {/* Pyramid rows */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: gap }}>
        {Array.from({ length: 7 }).map((_, row) => (
          <div key={row} style={{ display: "flex", gap: gap, justifyContent: "center" }}>
            {Array.from({ length: row + 1 }).map((_, col) => {
              const idx = pyramidIndex(row, col);
              const card = state.pyramid[idx];
              const exposed = card ? isExposed(state.pyramid, idx) : false;
              const isSelected =
                selection?.source === "pyramid" && selection.colIdx === idx;
              return (
                <div key={col}>
                  {card ? (
                    <CardView
                      card={card}
                      width={cardWidth}
                      height={cardHeight}
                      selected={isSelected}
                      onClick={exposed ? () => handlePyramidClick(idx) : undefined}
                      style={{ opacity: exposed ? 1 : 0.5 }}
                    />
                  ) : (
                    <div style={{ width: cardWidth, height: cardHeight }} />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Stock + Waste row */}
      <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "flex-start" }}>
        <div onClick={handleStockClick} style={{ cursor: state.stock.length > 0 ? "pointer" : "default" }}>
          {state.stock.length > 0 ? (
            <CardView
              card={{ ...state.stock[state.stock.length - 1], faceUp: false } as Card}
              width={cardWidth}
              height={cardHeight}
            />
          ) : (
            <CardView card={null} width={cardWidth} height={cardHeight} empty />
          )}
        </div>
        <div>
          {state.waste.length > 0 ? (
            <CardView
              card={state.waste[state.waste.length - 1]}
              width={cardWidth}
              height={cardHeight}
              selected={selection?.source === "waste"}
              onClick={handleWasteClick}
            />
          ) : (
            <CardView card={null} width={cardWidth} height={cardHeight} empty />
          )}
        </div>
        <span style={{ fontSize: 11, color: "var(--ezy-text-muted)", alignSelf: "center" }}>
          Pairs sum to 13
        </span>
      </div>

      <button
        onClick={handleUndo}
        disabled={undoStack.current.length === 0}
        style={{
          padding: "4px 14px",
          fontSize: 11,
          fontWeight: 600,
          color: undoStack.current.length > 0 ? "var(--ezy-text-secondary)" : "var(--ezy-text-muted)",
          backgroundColor: "var(--ezy-surface)",
          border: "1px solid var(--ezy-border)",
          borderRadius: 4,
          cursor: undoStack.current.length > 0 ? "pointer" : "default",
          opacity: undoStack.current.length > 0 ? 1 : 0.5,
        }}
      >
        Undo
      </button>
    </div>
  );
}

// ─── Main Solitaire Component ───────────────────────────────────────

export default function SolitaireGame({
  onAddTimedHighscore,
  onAddHighscore,
  paused = false,
}: SolitaireGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [variant, setVariant] = useState<SolitaireVariant | null>(null);
  const [spiderSuits, setSpiderSuits] = useState<SpiderSuits | null>(null);
  const [containerWidth, setContainerWidth] = useState(400);
  const [timer, setTimer] = useState(0);
  const [gameWon, setGameWon] = useState(false);
  const [pyramidScore, setPyramidScore] = useState(0);
  const [gameKey, setGameKey] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Timer
  useEffect(() => {
    if (variant && !gameWon && !paused) {
      timerRef.current = setInterval(() => setTimer((t) => t + 1), 1000);
      return () => clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [variant, gameWon, paused]);

  // Card sizing: responsive
  const divisor = variant === "spider" ? 12 : variant === "freecell" ? 10 : 9;
  const cardWidth = Math.max(36, Math.min(56, Math.floor(containerWidth / divisor)));
  const cardHeight = Math.floor(cardWidth * 1.4);
  const overlapY = Math.max(14, Math.floor(cardHeight * 0.22));

  const startVariant = useCallback((v: SolitaireVariant) => {
    setVariant(v);
    setTimer(0);
    setGameWon(false);
    setPyramidScore(0);
    setGameKey((k) => k + 1);
    if (v === "spider") {
      // Show suit selector first
      setSpiderSuits(null);
    } else {
      setSpiderSuits(null);
    }
  }, []);

  const startSpider = useCallback((suits: SpiderSuits) => {
    setSpiderSuits(suits);
    setTimer(0);
    setGameWon(false);
    setGameKey((k) => k + 1);
  }, []);

  const handleWin = useCallback(() => {
    setGameWon(true);
    clearInterval(timerRef.current);
    if (variant === "klondike") {
      onAddTimedHighscore("solitaireKlondike", timer);
    } else if (variant === "spider") {
      onAddTimedHighscore("solitaireSpider", timer);
    } else if (variant === "freecell") {
      onAddTimedHighscore("solitaireFreecell", timer);
    }
  }, [variant, timer, onAddTimedHighscore]);

  const handlePyramidWin = useCallback(
    (score: number) => {
      setGameWon(true);
      clearInterval(timerRef.current);
      onAddHighscore(score);
    },
    [onAddHighscore],
  );

  const handleNewGame = useCallback(() => {
    if (variant === "spider" && spiderSuits) {
      startSpider(spiderSuits);
    } else {
      setTimer(0);
      setGameWon(false);
      setPyramidScore(0);
      setGameKey((k) => k + 1);
    }
  }, [variant, spiderSuits, startSpider]);

  // Variant selector
  if (!variant) {
    return (
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          backgroundColor: "var(--ezy-bg)",
          padding: 16,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ezy-text)", marginBottom: 6 }}>
          Select Variant
        </div>
        {(
          [
            { key: "klondike" as const, name: "Klondike", desc: "Classic draw-1 solitaire" },
            { key: "spider" as const, name: "Spider", desc: "Build 8 suited sequences" },
            { key: "freecell" as const, name: "FreeCell", desc: "Strategic with 4 free cells" },
            { key: "pyramid" as const, name: "Pyramid", desc: "Pair cards that sum to 13" },
          ] as const
        ).map((v) => (
          <button
            key={v.key}
            onClick={() => startVariant(v.key)}
            style={{
              padding: "10px 24px",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ezy-text)",
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 6,
              cursor: "pointer",
              width: 220,
              textAlign: "left",
              transition: "border-color 120ms ease, background-color 120ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--ezy-accent)";
              e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--ezy-border)";
              e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
            }}
          >
            <div>{v.name}</div>
            <div style={{ fontSize: 11, fontWeight: 400, color: "var(--ezy-text-muted)", marginTop: 2 }}>
              {v.desc}
            </div>
          </button>
        ))}
      </div>
    );
  }

  // Spider suit selector
  if (variant === "spider" && spiderSuits === null) {
    return (
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          backgroundColor: "var(--ezy-bg)",
          padding: 16,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ezy-text)", marginBottom: 6 }}>
          Spider - Number of Suits
        </div>
        {(
          [
            { suits: 1 as SpiderSuits, label: "1 Suit", desc: "Easy" },
            { suits: 2 as SpiderSuits, label: "2 Suits", desc: "Medium" },
            { suits: 4 as SpiderSuits, label: "4 Suits", desc: "Hard" },
          ] as const
        ).map((opt) => (
          <button
            key={opt.suits}
            onClick={() => startSpider(opt.suits)}
            style={{
              padding: "10px 24px",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ezy-text)",
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 6,
              cursor: "pointer",
              width: 180,
              textAlign: "center",
              transition: "border-color 120ms ease, background-color 120ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--ezy-accent)";
              e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--ezy-border)";
              e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
            }}
          >
            <div>{opt.label}</div>
            <div style={{ fontSize: 11, fontWeight: 400, color: "var(--ezy-text-muted)", marginTop: 2 }}>
              {opt.desc}
            </div>
          </button>
        ))}
        <button
          onClick={() => setVariant(null)}
          style={{
            padding: "6px 16px",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--ezy-text-muted)",
            backgroundColor: "transparent",
            border: "none",
            cursor: "pointer",
            marginTop: 4,
          }}
        >
          Back
        </button>
      </div>
    );
  }

  const variantLabel =
    variant === "klondike"
      ? "Klondike"
      : variant === "spider"
        ? `Spider (${spiderSuits} suit${spiderSuits! > 1 ? "s" : ""})`
        : variant === "freecell"
          ? "FreeCell"
          : "Pyramid";

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      style={{
        width: "100%",
        height: "100%",
        outline: "none",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--ezy-bg)",
      }}
    >
      {/* Score bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 12px",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--ezy-text-secondary)",
          borderBottom: "1px solid var(--ezy-border)",
          fontVariantNumeric: "tabular-nums",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11, color: "var(--ezy-text-muted)" }}>{variantLabel}</span>
        {variant === "pyramid" ? (
          <span>
            Score: <span style={{ color: "var(--ezy-accent)" }}>{pyramidScore}</span>
          </span>
        ) : (
          <span>{formatTime(timer)}</span>
        )}
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={handleNewGame}
            style={{
              padding: "3px 10px",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ezy-text-secondary)",
              backgroundColor: "var(--ezy-surface)",
              border: "1px solid var(--ezy-border)",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            New
          </button>
          <button
            onClick={() => {
              setVariant(null);
              setSpiderSuits(null);
              setGameWon(false);
              setTimer(0);
            }}
            style={{
              padding: "3px 10px",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ezy-text-muted)",
              backgroundColor: "transparent",
              border: "1px solid var(--ezy-border)",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Back
          </button>
        </div>
      </div>

      {/* Game area */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        {variant === "klondike" && (
          <KlondikeGame
            key={gameKey}
            cardWidth={cardWidth}
            cardHeight={cardHeight}
            overlapY={overlapY}
            onWin={handleWin}
            paused={paused}
          />
        )}
        {variant === "spider" && spiderSuits !== null && (
          <SpiderGame
            key={gameKey}
            cardWidth={cardWidth}
            cardHeight={cardHeight}
            overlapY={overlapY}
            onWin={handleWin}
            paused={paused}
            suitCount={spiderSuits}
          />
        )}
        {variant === "freecell" && (
          <FreeCellGame
            key={gameKey}
            cardWidth={cardWidth}
            cardHeight={cardHeight}
            overlapY={overlapY}
            onWin={handleWin}
            paused={paused}
          />
        )}
        {variant === "pyramid" && (
          <PyramidGame
            key={gameKey}
            cardWidth={cardWidth}
            cardHeight={cardHeight}
            onWin={handlePyramidWin}
            onScoreUpdate={setPyramidScore}
            paused={paused}
          />
        )}

        {/* Win overlay */}
        {gameWon && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(0,0,0,0.7)",
              gap: 12,
              zIndex: 50,
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, color: "#4ade80" }}>You Win!</div>
            {variant === "pyramid" ? (
              <div style={{ fontSize: 14, color: "var(--ezy-accent)", fontWeight: 600 }}>
                Score: {pyramidScore}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--ezy-text-secondary)" }}>
                Time: {formatTime(timer)}
              </div>
            )}
            <button
              onClick={handleNewGame}
              style={{
                padding: "8px 24px",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--ezy-bg)",
                backgroundColor: "var(--ezy-accent)",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              Play Again
            </button>
          </div>
        )}

        {/* Pause overlay */}
        {paused && !gameWon && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(0,0,0,0.6)",
              zIndex: 50,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ezy-text-muted)" }}>Paused</div>
          </div>
        )}
      </div>
    </div>
  );
}

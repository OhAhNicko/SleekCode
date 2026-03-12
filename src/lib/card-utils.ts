export type Suit = "spades" | "hearts" | "diamonds" | "clubs";
export type Rank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";

export interface Card {
  suit: Suit;
  rank: Rank;
  faceUp: boolean;
  id: string;
}

const SUITS: Suit[] = ["spades", "hearts", "diamonds", "clubs"];
const RANKS: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, faceUp: false, id: `${suit}-${rank}` });
    }
  }
  return deck;
}

export function shuffleDeck(deck: Card[]): Card[] {
  const a = [...deck];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function rankValue(rank: Rank): number {
  switch (rank) {
    case "A": return 1;
    case "2": return 2;
    case "3": return 3;
    case "4": return 4;
    case "5": return 5;
    case "6": return 6;
    case "7": return 7;
    case "8": return 8;
    case "9": return 9;
    case "10": return 10;
    case "J": return 11;
    case "Q": return 12;
    case "K": return 13;
  }
}

export function isRed(suit: Suit): boolean {
  return suit === "hearts" || suit === "diamonds";
}

export function isBlack(suit: Suit): boolean {
  return suit === "spades" || suit === "clubs";
}

export function canStackTableau(moving: Card, target: Card): boolean {
  // Alternating color, descending rank (target is one higher)
  if (isRed(moving.suit) === isRed(target.suit)) return false;
  return rankValue(target.rank) === rankValue(moving.rank) + 1;
}

export function canStackFoundation(card: Card, topOfFoundation: Card | null): boolean {
  if (topOfFoundation === null) return card.rank === "A";
  if (card.suit !== topOfFoundation.suit) return false;
  return rankValue(card.rank) === rankValue(topOfFoundation.rank) + 1;
}

export function suitColor(suit: Suit): string {
  return isRed(suit) ? "#f87171" : "var(--ezy-text)";
}

/**
 * Returns an SVG path data string for the given suit symbol.
 * Designed for a 12x12 viewBox.
 */
export function suitSymbol(suit: Suit): string {
  switch (suit) {
    case "spades":
      // Spade shape
      return "M6 1 C6 1 1 5 1 7.5 C1 9.5 3 11 6 8.5 C6 8.5 5 11 4 11 L8 11 C7 11 6 8.5 6 8.5 C9 11 11 9.5 11 7.5 C11 5 6 1 6 1Z";
    case "hearts":
      // Heart shape
      return "M6 10.5 C6 10.5 1 7 1 4.5 C1 2.5 3 1 4.5 1 C5.3 1 6 1.8 6 2.5 C6 1.8 6.7 1 7.5 1 C9 1 11 2.5 11 4.5 C11 7 6 10.5 6 10.5Z";
    case "diamonds":
      // Diamond shape
      return "M6 1 L10.5 6 L6 11 L1.5 6 Z";
    case "clubs":
      // Club shape
      return "M6 1.5 C4.5 1.5 3.5 2.5 3.5 3.8 C3.5 5 4.5 5.5 4.5 5.5 C2.5 5 1.5 6 1.5 7.2 C1.5 8.5 2.8 9.5 4.2 9.5 C5.2 9.5 5.8 9 6 8.5 C5.5 10 4.5 11 4 11 L8 11 C7.5 11 6.5 10 6 8.5 C6.2 9 6.8 9.5 7.8 9.5 C9.2 9.5 10.5 8.5 10.5 7.2 C10.5 6 9.5 5 7.5 5.5 C7.5 5.5 8.5 5 8.5 3.8 C8.5 2.5 7.5 1.5 6 1.5Z";
  }
}

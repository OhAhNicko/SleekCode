import { useState, useEffect, useCallback, useRef, useMemo } from "react";

interface ChessGameProps {
  onUpdateStats: (difficulty: "easy" | "medium" | "hard", result: "win" | "loss" | "draw") => void;
  paused?: boolean;
}

// ─── Types ──────────────────────────────────────────────────────────

type PieceType = "K" | "Q" | "R" | "B" | "N" | "P";
type PieceColor = "w" | "b";
type Piece = { type: PieceType; color: PieceColor };
type Square = Piece | null;
type Board = Square[];
type Difficulty = "easy" | "medium" | "hard";
type GamePhase = "select" | "playing";
type GameResult = "playing" | "checkmate" | "stalemate" | "draw50" | "drawMaterial";

interface GameState {
  board: Board;
  turn: PieceColor;
  castling: { wK: boolean; wQ: boolean; bK: boolean; bQ: boolean };
  enPassantTarget: number | null;
  halfMoveClock: number;
  fullMoveNumber: number;
}

interface MoveRecord {
  from: number;
  to: number;
  piece: Piece;
  captured?: Piece;
  promotion?: PieceType;
  castle?: "K" | "Q";
  enPassant?: boolean;
  algebraic: string;
  check?: boolean;
  checkmate?: boolean;
}

interface Move {
  from: number;
  to: number;
  promotion?: PieceType;
  castle?: "K" | "Q";
  enPassant?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────

const FONT_UI = "var(--ezy-font-ui, Inter Variable, system-ui, sans-serif)";
const ANIM_MS = 200;

const PIECE_UNICODE: Record<PieceColor, Record<PieceType, string>> = {
  w: { K: "\u2654", Q: "\u2655", R: "\u2656", B: "\u2657", N: "\u2658", P: "\u2659" },
  b: { K: "\u265A", Q: "\u265B", R: "\u265C", B: "\u265D", N: "\u265E", P: "\u265F" },
};

const MATERIAL_VALUES: Record<PieceType, number> = {
  P: 100, N: 320, B: 330, R: 500, Q: 900, K: 20000,
};

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

// ─── Board helpers ──────────────────────────────────────────────────

function toRowCol(idx: number): [number, number] {
  return [Math.floor(idx / 8), idx % 8];
}

function toIndex(row: number, col: number): number {
  return row * 8 + col;
}

function isOnBoard(row: number, col: number): boolean {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

function toAlgebraic(idx: number): string {
  const [row, col] = toRowCol(idx);
  return FILES[col] + (8 - row);
}

function opponent(color: PieceColor): PieceColor {
  return color === "w" ? "b" : "w";
}

// ─── Initial position ───────────────────────────────────────────────

function createInitialBoard(): Board {
  const board: Board = new Array(64).fill(null);
  const backRank: PieceType[] = ["R", "N", "B", "Q", "K", "B", "N", "R"];

  for (let col = 0; col < 8; col++) {
    board[toIndex(0, col)] = { type: backRank[col], color: "b" };
    board[toIndex(1, col)] = { type: "P", color: "b" };
    board[toIndex(6, col)] = { type: "P", color: "w" };
    board[toIndex(7, col)] = { type: backRank[col], color: "w" };
  }

  return board;
}

function createInitialGameState(): GameState {
  return {
    board: createInitialBoard(),
    turn: "w",
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    enPassantTarget: null,
    halfMoveClock: 0,
    fullMoveNumber: 1,
  };
}

// ─── Attack detection ───────────────────────────────────────────────

function isSquareAttacked(board: Board, squareIdx: number, byColor: PieceColor): boolean {
  const [tRow, tCol] = toRowCol(squareIdx);

  // Knight attacks
  const knightOffsets = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  for (const [dr, dc] of knightOffsets) {
    const r = tRow + dr, c = tCol + dc;
    if (isOnBoard(r, c)) {
      const p = board[toIndex(r, c)];
      if (p && p.color === byColor && p.type === "N") return true;
    }
  }

  // King attacks
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = tRow + dr, c = tCol + dc;
      if (isOnBoard(r, c)) {
        const p = board[toIndex(r, c)];
        if (p && p.color === byColor && p.type === "K") return true;
      }
    }
  }

  // Pawn attacks
  const pawnDir = byColor === "w" ? 1 : -1; // attacking FROM byColor pawns toward target
  for (const dc of [-1, 1]) {
    const r = tRow + pawnDir, c = tCol + dc;
    if (isOnBoard(r, c)) {
      const p = board[toIndex(r, c)];
      if (p && p.color === byColor && p.type === "P") return true;
    }
  }

  // Sliding pieces: bishop/queen (diagonals)
  const diagonals = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  for (const [dr, dc] of diagonals) {
    let r = tRow + dr, c = tCol + dc;
    while (isOnBoard(r, c)) {
      const p = board[toIndex(r, c)];
      if (p) {
        if (p.color === byColor && (p.type === "B" || p.type === "Q")) return true;
        break;
      }
      r += dr;
      c += dc;
    }
  }

  // Sliding pieces: rook/queen (orthogonals)
  const orthogonals = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dr, dc] of orthogonals) {
    let r = tRow + dr, c = tCol + dc;
    while (isOnBoard(r, c)) {
      const p = board[toIndex(r, c)];
      if (p) {
        if (p.color === byColor && (p.type === "R" || p.type === "Q")) return true;
        break;
      }
      r += dr;
      c += dc;
    }
  }

  return false;
}

function findKing(board: Board, color: PieceColor): number {
  for (let i = 0; i < 64; i++) {
    if (board[i]?.color === color && board[i]?.type === "K") return i;
  }
  return -1; // should never happen in valid game
}

function isInCheck(board: Board, color: PieceColor): boolean {
  const kingIdx = findKing(board, color);
  if (kingIdx === -1) return false;
  return isSquareAttacked(board, kingIdx, opponent(color));
}

// ─── Move generation ────────────────────────────────────────────────

function generatePseudoLegalMoves(state: GameState): Move[] {
  const moves: Move[] = [];
  const { board, turn, castling, enPassantTarget } = state;

  for (let idx = 0; idx < 64; idx++) {
    const piece = board[idx];
    if (!piece || piece.color !== turn) continue;

    const [row, col] = toRowCol(idx);

    switch (piece.type) {
      case "P": {
        const dir = turn === "w" ? -1 : 1;
        const startRow = turn === "w" ? 6 : 1;
        const promoRow = turn === "w" ? 0 : 7;

        // Forward 1
        const fwd1 = toIndex(row + dir, col);
        if (isOnBoard(row + dir, col) && !board[fwd1]) {
          if (row + dir === promoRow) {
            for (const pt of ["Q", "R", "B", "N"] as PieceType[]) {
              moves.push({ from: idx, to: fwd1, promotion: pt });
            }
          } else {
            moves.push({ from: idx, to: fwd1 });
          }

          // Forward 2 from start
          if (row === startRow) {
            const fwd2 = toIndex(row + 2 * dir, col);
            if (!board[fwd2]) {
              moves.push({ from: idx, to: fwd2 });
            }
          }
        }

        // Diagonal captures
        for (const dc of [-1, 1]) {
          const nr = row + dir, nc = col + dc;
          if (!isOnBoard(nr, nc)) continue;
          const target = toIndex(nr, nc);
          const targetPiece = board[target];

          if (targetPiece && targetPiece.color !== turn) {
            if (nr === promoRow) {
              for (const pt of ["Q", "R", "B", "N"] as PieceType[]) {
                moves.push({ from: idx, to: target, promotion: pt });
              }
            } else {
              moves.push({ from: idx, to: target });
            }
          }

          // En passant
          if (enPassantTarget !== null && target === enPassantTarget) {
            moves.push({ from: idx, to: target, enPassant: true });
          }
        }
        break;
      }

      case "N": {
        const knightOffsets = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
        for (const [dr, dc] of knightOffsets) {
          const nr = row + dr, nc = col + dc;
          if (!isOnBoard(nr, nc)) continue;
          const target = toIndex(nr, nc);
          if (!board[target] || board[target]!.color !== turn) {
            moves.push({ from: idx, to: target });
          }
        }
        break;
      }

      case "B": {
        const dirs = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
        for (const [dr, dc] of dirs) {
          let nr = row + dr, nc = col + dc;
          while (isOnBoard(nr, nc)) {
            const target = toIndex(nr, nc);
            if (board[target]) {
              if (board[target]!.color !== turn) moves.push({ from: idx, to: target });
              break;
            }
            moves.push({ from: idx, to: target });
            nr += dr;
            nc += dc;
          }
        }
        break;
      }

      case "R": {
        const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (const [dr, dc] of dirs) {
          let nr = row + dr, nc = col + dc;
          while (isOnBoard(nr, nc)) {
            const target = toIndex(nr, nc);
            if (board[target]) {
              if (board[target]!.color !== turn) moves.push({ from: idx, to: target });
              break;
            }
            moves.push({ from: idx, to: target });
            nr += dr;
            nc += dc;
          }
        }
        break;
      }

      case "Q": {
        const dirs = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
        for (const [dr, dc] of dirs) {
          let nr = row + dr, nc = col + dc;
          while (isOnBoard(nr, nc)) {
            const target = toIndex(nr, nc);
            if (board[target]) {
              if (board[target]!.color !== turn) moves.push({ from: idx, to: target });
              break;
            }
            moves.push({ from: idx, to: target });
            nr += dr;
            nc += dc;
          }
        }
        break;
      }

      case "K": {
        // Regular king moves
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = row + dr, nc = col + dc;
            if (!isOnBoard(nr, nc)) continue;
            const target = toIndex(nr, nc);
            if (!board[target] || board[target]!.color !== turn) {
              moves.push({ from: idx, to: target });
            }
          }
        }

        // Castling
        if (turn === "w") {
          // Kingside: e1-g1
          if (castling.wK && col === 4 && row === 7) {
            const rookSq = board[toIndex(7, 7)];
            if (rookSq && rookSq.type === "R" && rookSq.color === "w" &&
                !board[toIndex(7, 5)] && !board[toIndex(7, 6)] &&
                !isSquareAttacked(board, idx, "b") &&
                !isSquareAttacked(board, toIndex(7, 5), "b") &&
                !isSquareAttacked(board, toIndex(7, 6), "b")) {
              moves.push({ from: idx, to: toIndex(7, 6), castle: "K" });
            }
          }
          // Queenside: e1-c1
          if (castling.wQ && col === 4 && row === 7) {
            const rookSq = board[toIndex(7, 0)];
            if (rookSq && rookSq.type === "R" && rookSq.color === "w" &&
                !board[toIndex(7, 1)] && !board[toIndex(7, 2)] && !board[toIndex(7, 3)] &&
                !isSquareAttacked(board, idx, "b") &&
                !isSquareAttacked(board, toIndex(7, 3), "b") &&
                !isSquareAttacked(board, toIndex(7, 2), "b")) {
              moves.push({ from: idx, to: toIndex(7, 2), castle: "Q" });
            }
          }
        } else {
          // Kingside: e8-g8
          if (castling.bK && col === 4 && row === 0) {
            const rookSq = board[toIndex(0, 7)];
            if (rookSq && rookSq.type === "R" && rookSq.color === "b" &&
                !board[toIndex(0, 5)] && !board[toIndex(0, 6)] &&
                !isSquareAttacked(board, idx, "w") &&
                !isSquareAttacked(board, toIndex(0, 5), "w") &&
                !isSquareAttacked(board, toIndex(0, 6), "w")) {
              moves.push({ from: idx, to: toIndex(0, 6), castle: "K" });
            }
          }
          // Queenside: e8-c8
          if (castling.bQ && col === 4 && row === 0) {
            const rookSq = board[toIndex(0, 0)];
            if (rookSq && rookSq.type === "R" && rookSq.color === "b" &&
                !board[toIndex(0, 1)] && !board[toIndex(0, 2)] && !board[toIndex(0, 3)] &&
                !isSquareAttacked(board, idx, "w") &&
                !isSquareAttacked(board, toIndex(0, 3), "w") &&
                !isSquareAttacked(board, toIndex(0, 2), "w")) {
              moves.push({ from: idx, to: toIndex(0, 2), castle: "Q" });
            }
          }
        }
        break;
      }
    }
  }

  return moves;
}

function cloneBoard(board: Board): Board {
  return board.map((sq) => (sq ? { ...sq } : null));
}

function applyMoveToBoard(board: Board, move: Move, turn: PieceColor): Board {
  const newBoard = cloneBoard(board);
  const piece = newBoard[move.from]!;

  // En passant capture
  if (move.enPassant) {
    const capturedPawnRow = turn === "w" ? toRowCol(move.to)[0] + 1 : toRowCol(move.to)[0] - 1;
    newBoard[toIndex(capturedPawnRow, toRowCol(move.to)[1])] = null;
  }

  // Castling: move the rook
  if (move.castle) {
    const row = toRowCol(move.from)[0];
    if (move.castle === "K") {
      newBoard[toIndex(row, 5)] = newBoard[toIndex(row, 7)];
      newBoard[toIndex(row, 7)] = null;
    } else {
      newBoard[toIndex(row, 3)] = newBoard[toIndex(row, 0)];
      newBoard[toIndex(row, 0)] = null;
    }
  }

  // Move the piece
  newBoard[move.to] = move.promotion
    ? { type: move.promotion, color: turn }
    : piece;
  newBoard[move.from] = null;

  return newBoard;
}

function generateLegalMoves(state: GameState): Move[] {
  const pseudoLegal = generatePseudoLegalMoves(state);
  const legal: Move[] = [];

  for (const move of pseudoLegal) {
    const newBoard = applyMoveToBoard(state.board, move, state.turn);
    if (!isInCheck(newBoard, state.turn)) {
      legal.push(move);
    }
  }

  return legal;
}

// ─── Apply move (full state update) ─────────────────────────────────

function applyMove(state: GameState, move: Move): { newState: GameState; record: MoveRecord } {
  const piece = state.board[move.from]!;
  const captured = move.enPassant
    ? state.board[toIndex(
        state.turn === "w" ? toRowCol(move.to)[0] + 1 : toRowCol(move.to)[0] - 1,
        toRowCol(move.to)[1]
      )]
    : state.board[move.to] || undefined;

  const newBoard = applyMoveToBoard(state.board, move, state.turn);

  // Update castling rights
  const newCastling = { ...state.castling };
  if (piece.type === "K") {
    if (state.turn === "w") { newCastling.wK = false; newCastling.wQ = false; }
    else { newCastling.bK = false; newCastling.bQ = false; }
  }
  if (piece.type === "R") {
    if (move.from === toIndex(7, 0)) newCastling.wQ = false;
    if (move.from === toIndex(7, 7)) newCastling.wK = false;
    if (move.from === toIndex(0, 0)) newCastling.bQ = false;
    if (move.from === toIndex(0, 7)) newCastling.bK = false;
  }
  // If a rook is captured
  if (move.to === toIndex(7, 0)) newCastling.wQ = false;
  if (move.to === toIndex(7, 7)) newCastling.wK = false;
  if (move.to === toIndex(0, 0)) newCastling.bQ = false;
  if (move.to === toIndex(0, 7)) newCastling.bK = false;

  // En passant target
  let newEnPassant: number | null = null;
  if (piece.type === "P") {
    const [fromRow] = toRowCol(move.from);
    const [toRow, toCol] = toRowCol(move.to);
    if (Math.abs(toRow - fromRow) === 2) {
      newEnPassant = toIndex((fromRow + toRow) / 2, toCol);
    }
  }

  // Half-move clock
  const newHalfMove = (piece.type === "P" || captured) ? 0 : state.halfMoveClock + 1;

  const nextTurn = opponent(state.turn);
  const newFullMove = state.turn === "b" ? state.fullMoveNumber + 1 : state.fullMoveNumber;

  const newState: GameState = {
    board: newBoard,
    turn: nextTurn,
    castling: newCastling,
    enPassantTarget: newEnPassant,
    halfMoveClock: newHalfMove,
    fullMoveNumber: newFullMove,
  };

  // Generate algebraic notation
  const algebraic = generateAlgebraic(state, move, piece, captured || undefined, newState);

  const record: MoveRecord = {
    from: move.from,
    to: move.to,
    piece: { ...piece },
    captured: captured ? { ...captured } : undefined,
    promotion: move.promotion,
    castle: move.castle,
    enPassant: move.enPassant,
    algebraic,
    check: isInCheck(newBoard, nextTurn),
    checkmate: false,
  };

  // Check for checkmate
  if (record.check) {
    const nextLegalMoves = generateLegalMoves(newState);
    if (nextLegalMoves.length === 0) {
      record.checkmate = true;
      record.algebraic = record.algebraic.replace(/\+$/, "#");
    }
  }

  return { newState, record };
}

// ─── Algebraic notation ─────────────────────────────────────────────

function generateAlgebraic(
  state: GameState, move: Move, piece: Piece,
  captured: Piece | undefined, newState: GameState
): string {
  if (move.castle === "K") {
    const suffix = isInCheck(newState.board, newState.turn) ? "+" : "";
    return "O-O" + suffix;
  }
  if (move.castle === "Q") {
    const suffix = isInCheck(newState.board, newState.turn) ? "+" : "";
    return "O-O-O" + suffix;
  }

  let notation = "";
  const [, fromCol] = toRowCol(move.from);
  const dest = toAlgebraic(move.to);

  if (piece.type === "P") {
    if (captured || move.enPassant) {
      notation = FILES[fromCol] + "x" + dest;
    } else {
      notation = dest;
    }
    if (move.promotion) {
      notation += "=" + move.promotion;
    }
  } else {
    notation = piece.type;

    // Disambiguation
    const sameTypeMoves = generateLegalMoves(state).filter(
      (m) => m.to === move.to && m.from !== move.from &&
        state.board[m.from]?.type === piece.type
    );

    if (sameTypeMoves.length > 0) {
      const [fromRow] = toRowCol(move.from);
      const sameFile = sameTypeMoves.some((m) => toRowCol(m.from)[1] === fromCol);
      const sameRank = sameTypeMoves.some((m) => toRowCol(m.from)[0] === fromRow);

      if (!sameFile) {
        notation += FILES[fromCol];
      } else if (!sameRank) {
        notation += (8 - fromRow).toString();
      } else {
        notation += FILES[fromCol] + (8 - fromRow).toString();
      }
    }

    if (captured) {
      notation += "x";
    }
    notation += dest;
  }

  if (isInCheck(newState.board, newState.turn)) {
    notation += "+";
  }

  return notation;
}

// ─── Game end detection ─────────────────────────────────────────────

function detectGameEnd(state: GameState): { result: GameResult; winner: PieceColor | null } {
  const legalMoves = generateLegalMoves(state);

  if (legalMoves.length === 0) {
    if (isInCheck(state.board, state.turn)) {
      return { result: "checkmate", winner: opponent(state.turn) };
    }
    return { result: "stalemate", winner: null };
  }

  if (state.halfMoveClock >= 100) {
    return { result: "draw50", winner: null };
  }

  if (isInsufficientMaterial(state.board)) {
    return { result: "drawMaterial", winner: null };
  }

  return { result: "playing", winner: null };
}

function isInsufficientMaterial(board: Board): boolean {
  const pieces: Piece[] = [];
  for (let i = 0; i < 64; i++) {
    if (board[i]) pieces.push(board[i]!);
  }

  // King vs King
  if (pieces.length === 2) return true;

  // King + minor vs King
  if (pieces.length === 3) {
    const nonKing = pieces.find((p) => p.type !== "K");
    if (nonKing && (nonKing.type === "B" || nonKing.type === "N")) return true;
  }

  // King + Bishop vs King + Bishop (same colored bishops)
  if (pieces.length === 4) {
    const bishops = pieces.filter((p) => p.type === "B");
    if (bishops.length === 2 && bishops[0].color !== bishops[1].color) {
      // Find bishop squares
      const bishopIndices: number[] = [];
      for (let i = 0; i < 64; i++) {
        if (board[i]?.type === "B") bishopIndices.push(i);
      }
      if (bishopIndices.length === 2) {
        const [r1, c1] = toRowCol(bishopIndices[0]);
        const [r2, c2] = toRowCol(bishopIndices[1]);
        if ((r1 + c1) % 2 === (r2 + c2) % 2) return true;
      }
    }
  }

  return false;
}

// ─── Piece-square tables (simplified) ───────────────────────────────

const PST_PAWN = [
   0,  0,  0,  0,  0,  0,  0,  0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
   5,  5, 10, 25, 25, 10,  5,  5,
   0,  0,  0, 20, 20,  0,  0,  0,
   5, -5,-10,  0,  0,-10, -5,  5,
   5, 10, 10,-20,-20, 10, 10,  5,
   0,  0,  0,  0,  0,  0,  0,  0,
];

const PST_KNIGHT = [
  -50,-40,-30,-30,-30,-30,-40,-50,
  -40,-20,  0,  0,  0,  0,-20,-40,
  -30,  0, 10, 15, 15, 10,  0,-30,
  -30,  5, 15, 20, 20, 15,  5,-30,
  -30,  0, 15, 20, 20, 15,  0,-30,
  -30,  5, 10, 15, 15, 10,  5,-30,
  -40,-20,  0,  5,  5,  0,-20,-40,
  -50,-40,-30,-30,-30,-30,-40,-50,
];

const PST_BISHOP = [
  -20,-10,-10,-10,-10,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0, 10, 10, 10, 10,  0,-10,
  -10,  5,  5, 10, 10,  5,  5,-10,
  -10,  0, 10, 10, 10, 10,  0,-10,
  -10, 10, 10, 10, 10, 10, 10,-10,
  -10,  5,  0,  0,  0,  0,  5,-10,
  -20,-10,-10,-10,-10,-10,-10,-20,
];

const PST_ROOK = [
   0,  0,  0,  0,  0,  0,  0,  0,
   5, 10, 10, 10, 10, 10, 10,  5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
  -5,  0,  0,  0,  0,  0,  0, -5,
   0,  0,  0,  5,  5,  0,  0,  0,
];

const PST_QUEEN = [
  -20,-10,-10, -5, -5,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5,  5,  5,  5,  0,-10,
   -5,  0,  5,  5,  5,  5,  0, -5,
    0,  0,  5,  5,  5,  5,  0, -5,
  -10,  5,  5,  5,  5,  5,  0,-10,
  -10,  0,  5,  0,  0,  0,  0,-10,
  -20,-10,-10, -5, -5,-10,-10,-20,
];

const PST_KING_MID = [
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -30,-40,-40,-50,-50,-40,-40,-30,
  -20,-30,-30,-40,-40,-30,-30,-20,
  -10,-20,-20,-20,-20,-20,-20,-10,
   20, 20,  0,  0,  0,  0, 20, 20,
   20, 30, 10,  0,  0, 10, 30, 20,
];

const PST_MAP: Record<PieceType, number[]> = {
  P: PST_PAWN,
  N: PST_KNIGHT,
  B: PST_BISHOP,
  R: PST_ROOK,
  Q: PST_QUEEN,
  K: PST_KING_MID,
};

// ─── Evaluation ─────────────────────────────────────────────────────

function evaluate(board: Board): number {
  let score = 0;

  for (let i = 0; i < 64; i++) {
    const piece = board[i];
    if (!piece) continue;

    const material = MATERIAL_VALUES[piece.type];
    const pstIdx = piece.color === "w" ? i : (7 - Math.floor(i / 8)) * 8 + (i % 8);
    const pst = PST_MAP[piece.type][pstIdx];

    if (piece.color === "w") {
      score += material + pst;
    } else {
      score -= material + pst;
    }
  }

  return score;
}

// ─── AI ─────────────────────────────────────────────────────────────

function aiEasy(state: GameState): Move {
  const moves = generateLegalMoves(state);
  // Depth-1 evaluation with randomness: picks from the top ~30% of moves
  const scored = moves.map((m) => {
    const { newState } = applyMove(state, m);
    return { move: m, score: evaluate(newState.board) };
  });
  // AI is black → prefers lower scores
  scored.sort((a, b) => a.score - b.score);
  // Pick randomly from the best third (at least top 3)
  const topN = Math.max(3, Math.ceil(scored.length * 0.3));
  const pool = scored.slice(0, topN);
  return pool[Math.floor(Math.random() * pool.length)].move;
}

function orderMoves(state: GameState, moves: Move[]): Move[] {
  return [...moves].sort((a, b) => {
    const captA = state.board[a.to];
    const captB = state.board[b.to];
    const scoreA = captA ? MATERIAL_VALUES[captA.type] - MATERIAL_VALUES[state.board[a.from]!.type] / 100 : 0;
    const scoreB = captB ? MATERIAL_VALUES[captB.type] - MATERIAL_VALUES[state.board[b.from]!.type] / 100 : 0;
    return scoreB - scoreA;
  });
}

function minimax(
  state: GameState,
  depth: number,
  alpha: number,
  beta: number,
  maximizing: boolean,
  quiescenceDepth: number
): number {
  if (depth <= 0) {
    if (quiescenceDepth > 0) {
      return quiescence(state, quiescenceDepth, alpha, beta, maximizing);
    }
    return evaluate(state.board);
  }

  const moves = orderMoves(state, generateLegalMoves(state));

  if (moves.length === 0) {
    if (isInCheck(state.board, state.turn)) {
      return maximizing ? -99999 + (3 - depth) : 99999 - (3 - depth);
    }
    return 0; // stalemate
  }

  if (maximizing) {
    let maxEval = -Infinity;
    for (const move of moves) {
      const { newState } = applyMove(state, move);
      const ev = minimax(newState, depth - 1, alpha, beta, false, quiescenceDepth);
      maxEval = Math.max(maxEval, ev);
      alpha = Math.max(alpha, ev);
      if (beta <= alpha) break;
    }
    return maxEval;
  } else {
    let minEval = Infinity;
    for (const move of moves) {
      const { newState } = applyMove(state, move);
      const ev = minimax(newState, depth - 1, alpha, beta, true, quiescenceDepth);
      minEval = Math.min(minEval, ev);
      beta = Math.min(beta, ev);
      if (beta <= alpha) break;
    }
    return minEval;
  }
}

function quiescence(
  state: GameState,
  depth: number,
  alpha: number,
  beta: number,
  maximizing: boolean
): number {
  const standPat = evaluate(state.board);

  if (maximizing) {
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;
  } else {
    if (standPat <= alpha) return alpha;
    if (standPat < beta) beta = standPat;
  }

  if (depth <= 0) return standPat;

  const allMoves = generateLegalMoves(state);
  const captures = allMoves.filter((m) => state.board[m.to] || m.enPassant);
  const ordered = orderMoves(state, captures);

  if (maximizing) {
    for (const move of ordered) {
      const { newState } = applyMove(state, move);
      const ev = quiescence(newState, depth - 1, alpha, beta, false);
      if (ev >= beta) return beta;
      if (ev > alpha) alpha = ev;
    }
    return alpha;
  } else {
    for (const move of ordered) {
      const { newState } = applyMove(state, move);
      const ev = quiescence(newState, depth - 1, alpha, beta, true);
      if (ev <= alpha) return alpha;
      if (ev < beta) beta = ev;
    }
    return beta;
  }
}

function aiBestMove(state: GameState, depth: number, quiescenceDepth: number): Move {
  const moves = orderMoves(state, generateLegalMoves(state));
  let bestMove = moves[0];
  let bestScore = Infinity; // AI is black, minimizing

  for (const move of moves) {
    const { newState } = applyMove(state, move);
    const score = minimax(newState, depth - 1, -Infinity, Infinity, true, quiescenceDepth);
    if (score < bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  return bestMove;
}

function aiMedium(state: GameState): Move {
  return aiBestMove(state, 2, 0);
}

function aiHard(state: GameState): Move {
  return aiBestMove(state, 3, 2);
}

// ─── Component ──────────────────────────────────────────────────────

export default function ChessGame({ onUpdateStats, paused }: ChessGameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const moveListRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<GamePhase>("select");
  const [difficulty, setDifficulty] = useState<Difficulty | null>(null);
  const [gameState, setGameState] = useState<GameState>(createInitialGameState);
  const [moveHistory, setMoveHistory] = useState<MoveRecord[]>([]);
  const [selectedSquare, setSelectedSquare] = useState<number | null>(null);
  const [legalMovesForSelected, setLegalMovesForSelected] = useState<number[]>([]);
  const [gameResult, setGameResult] = useState<GameResult>("playing");
  const [resultWinner, setResultWinner] = useState<PieceColor | null>(null);
  const [promotionPending, setPromotionPending] = useState<{ from: number; to: number } | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [containerWidth, setContainerWidth] = useState(600);
  const [containerHeight, setContainerHeight] = useState(400);
  const [cursorSquare, setCursorSquare] = useState<number | null>(null);
  const [lastMove, setLastMove] = useState<{ from: number; to: number } | null>(null);
  const [animating, setAnimating] = useState<{
    from: number; to: number; piece: Piece;
    fromX: number; fromY: number; toX: number; toY: number;
  } | null>(null);

  // Refs for stable callbacks
  const gameStateRef = useRef(gameState);
  gameStateRef.current = gameState;
  const gameResultRef = useRef(gameResult);
  gameResultRef.current = gameResult;
  const difficultyRef = useRef(difficulty);
  difficultyRef.current = difficulty;
  const aiThinkingRef = useRef(aiThinking);
  aiThinkingRef.current = aiThinking;

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerWidth(entry.contentRect.width);
        setContainerHeight(entry.contentRect.height);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Auto-scroll move list
  useEffect(() => {
    if (moveListRef.current) {
      moveListRef.current.scrollTop = moveListRef.current.scrollHeight;
    }
  }, [moveHistory]);

  // Focus container on phase change
  useEffect(() => {
    containerRef.current?.focus();
  }, [phase]);

  // Legal moves computation
  const allLegalMoves = useMemo(() => {
    if (gameResult !== "playing") return [];
    return generateLegalMoves(gameState);
  }, [gameState, gameResult]);

  // Handle square click
  const handleSquareClick = useCallback((idx: number) => {
    if (paused || gameResult !== "playing" || aiThinking || promotionPending) return;
    if (gameState.turn !== "w") return; // Player is white

    const piece = gameState.board[idx];

    if (selectedSquare !== null) {
      // Check if clicking a legal destination
      const move = allLegalMoves.find((m) =>
        m.from === selectedSquare && m.to === idx && !m.promotion
      );
      const promoMove = allLegalMoves.find((m) =>
        m.from === selectedSquare && m.to === idx && m.promotion
      );

      if (promoMove) {
        // Need promotion selection
        setPromotionPending({ from: selectedSquare, to: idx });
        setSelectedSquare(null);
        setLegalMovesForSelected([]);
        return;
      }

      if (move) {
        executeMove(move);
        return;
      }

      // Clicked own piece — re-select
      if (piece && piece.color === "w") {
        setSelectedSquare(idx);
        const moves = allLegalMoves.filter((m) => m.from === idx).map((m) => m.to);
        setLegalMovesForSelected([...new Set(moves)]);
        return;
      }

      // Clicked elsewhere — deselect
      setSelectedSquare(null);
      setLegalMovesForSelected([]);
      return;
    }

    // No selection — select own piece
    if (piece && piece.color === "w") {
      setSelectedSquare(idx);
      const moves = allLegalMoves.filter((m) => m.from === idx).map((m) => m.to);
      setLegalMovesForSelected([...new Set(moves)]);
    }
  }, [gameState, selectedSquare, allLegalMoves, paused, gameResult, aiThinking, promotionPending]);

  // Compute pixel position for a square index
  const squareSizeRef = useRef(0);
  const getSquarePos = useCallback((idx: number) => {
    const [row, col] = toRowCol(idx);
    const sz = squareSizeRef.current;
    return { x: col * sz, y: row * sz };
  }, []);

  // Apply move state + check game end
  const commitMove = useCallback((state: GameState, move: Move) => {
    const { newState, record } = applyMove(state, move);
    setGameState(newState);
    setMoveHistory((prev) => [...prev, record]);
    setLastMove({ from: move.from, to: move.to });
    setAnimating(null);

    const end = detectGameEnd(newState);
    if (end.result !== "playing") {
      setGameResult(end.result);
      setResultWinner(end.winner);
      if (difficultyRef.current) {
        onUpdateStats(
          difficultyRef.current,
          end.result === "checkmate" ? (end.winner === "w" ? "win" : "loss") : "draw"
        );
      }
      return newState;
    }
    return newState;
  }, [onUpdateStats]);

  // Animate a piece from source to destination, then call onDone
  const animateMove = useCallback((state: GameState, move: Move, onDone: (newState: GameState) => void) => {
    const piece = state.board[move.from];
    if (!piece) { onDone(state); return; }
    const from = getSquarePos(move.from);
    const to = getSquarePos(move.to);
    setAnimating({ from: move.from, to: move.to, piece, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
    // Let the browser paint the start position, then transition to end
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setAnimating((prev) => prev ? { ...prev, fromX: to.x, fromY: to.y } : null);
        setTimeout(() => onDone(state), ANIM_MS);
      });
    });
  }, [getSquarePos]);

  // Execute a move (player)
  const executeMove = useCallback((move: Move) => {
    setSelectedSquare(null);
    setLegalMovesForSelected([]);

    animateMove(gameStateRef.current, move, (prevState) => {
      const newState = commitMove(prevState, move);

      // AI turn
      if (newState.turn === "b" && detectGameEnd(newState).result === "playing") {
        setAiThinking(true);
        setTimeout(() => {
          if (gameResultRef.current !== "playing") return;

          const currentState = gameStateRef.current;
          const diff = difficultyRef.current;
          const aiMove = diff === "easy"
            ? aiEasy(currentState)
            : diff === "medium"
              ? aiMedium(currentState)
              : aiHard(currentState);

          animateMove(currentState, aiMove, (aiPrevState) => {
            commitMove(aiPrevState, aiMove);
            setAiThinking(false);
          });
        }, 300);
      }
    });
  }, [animateMove, commitMove]);

  // Handle promotion selection
  const handlePromotion = useCallback((pieceType: PieceType) => {
    if (!promotionPending) return;
    const move = allLegalMoves.find((m) =>
      m.from === promotionPending.from && m.to === promotionPending.to && m.promotion === pieceType
    );
    setPromotionPending(null);
    if (move) executeMove(move);
  }, [promotionPending, allLegalMoves, executeMove]);

  // Start new game
  const startGame = useCallback((diff: Difficulty) => {
    setDifficulty(diff);
    setGameState(createInitialGameState());
    setMoveHistory([]);
    setSelectedSquare(null);
    setLegalMovesForSelected([]);
    setGameResult("playing");
    setResultWinner(null);
    setPromotionPending(null);
    setAiThinking(false);
    setLastMove(null);
    setCursorSquare(null);
    setAnimating(null);
    setPhase("playing");
  }, []);

  const resetToSelect = useCallback(() => {
    setPhase("select");
    setDifficulty(null);
    setGameState(createInitialGameState());
    setMoveHistory([]);
    setSelectedSquare(null);
    setLegalMovesForSelected([]);
    setGameResult("playing");
    setResultWinner(null);
    setPromotionPending(null);
    setAiThinking(false);
    setLastMove(null);
    setCursorSquare(null);
    setAnimating(null);
  }, []);

  // Keyboard handler
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (paused || phase !== "playing") return;

    if (e.key === "Escape") {
      setSelectedSquare(null);
      setLegalMovesForSelected([]);
      setCursorSquare(null);
      return;
    }

    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault();
      setCursorSquare((prev) => {
        if (prev === null) return toIndex(7, 0); // Start at a1
        const [row, col] = toRowCol(prev);
        switch (e.key) {
          case "ArrowUp": return isOnBoard(row - 1, col) ? toIndex(row - 1, col) : prev;
          case "ArrowDown": return isOnBoard(row + 1, col) ? toIndex(row + 1, col) : prev;
          case "ArrowLeft": return isOnBoard(row, col - 1) ? toIndex(row, col - 1) : prev;
          case "ArrowRight": return isOnBoard(row, col + 1) ? toIndex(row, col + 1) : prev;
          default: return prev;
        }
      });
      return;
    }

    if (e.key === "Enter" && cursorSquare !== null) {
      e.preventDefault();
      handleSquareClick(cursorSquare);
      return;
    }
  }, [paused, phase, cursorSquare, handleSquareClick]);

  // ─── Board sizing ───────────────────────────────────────────────────

  const isCompact = containerWidth < 400;
  const scoreBarHeight = 33;
  const movePanelWidth = isCompact ? 0 : Math.max(100, Math.min(140, containerWidth * 0.3));
  const boardAreaWidth = isCompact ? containerWidth : containerWidth - movePanelWidth;
  const boardAreaHeight = isCompact
    ? containerHeight - scoreBarHeight - 120 // leave room for moves panel below
    : containerHeight - scoreBarHeight;
  const boardSizeMax = Math.min(boardAreaWidth - 20, boardAreaHeight - 20);
  const boardSize = Math.max(160, boardSizeMax);
  const squareSize = Math.floor(boardSize / 8);
  squareSizeRef.current = squareSize;
  const actualBoardSize = squareSize * 8;

  // King in check
  const kingInCheck = useMemo(() => {
    if (gameResult !== "playing" && gameResult !== "checkmate") return null;
    if (isInCheck(gameState.board, gameState.turn)) {
      return findKing(gameState.board, gameState.turn);
    }
    return null;
  }, [gameState, gameResult]);

  // ─── Select screen ─────────────────────────────────────────────────

  if (phase === "select") {
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
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ezy-text)", marginBottom: 8, fontFamily: FONT_UI }}>
            Select Difficulty
          </div>
          {([
            { key: "easy" as Difficulty, label: "Easy", desc: "Random moves, great for learning" },
            { key: "medium" as Difficulty, label: "Medium", desc: "Thinks 2 moves ahead" },
            { key: "hard" as Difficulty, label: "Hard", desc: "Thinks 3+ moves ahead, plays strong" },
          ]).map(({ key, label, desc }) => (
            <div
              key={key}
              onClick={() => startGame(key)}
              style={{
                width: "100%",
                maxWidth: 240,
                padding: "10px 16px",
                borderRadius: 6,
                backgroundColor: "var(--ezy-surface)",
                border: "1px solid var(--ezy-border)",
                cursor: "pointer",
                textAlign: "center",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--ezy-text)",
                transition: "background-color 150ms ease, border-color 150ms ease",
                fontFamily: FONT_UI,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)";
                e.currentTarget.style.borderColor = "var(--ezy-accent)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "var(--ezy-surface)";
                e.currentTarget.style.borderColor = "var(--ezy-border)";
              }}
            >
              {label}
              <div style={{ fontSize: 10, color: "var(--ezy-text-muted)", marginTop: 2, fontWeight: 400 }}>
                {desc}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ─── Game render ────────────────────────────────────────────────────

  const turnLabel = gameResult !== "playing"
    ? (gameResult === "checkmate"
        ? (resultWinner === "w" ? "Checkmate" : "Checkmate")
        : gameResult === "stalemate" ? "Stalemate"
        : gameResult === "draw50" ? "Draw (50-move)"
        : "Draw (insufficient)")
    : (gameState.turn === "w"
        ? (aiThinking ? "AI thinking..." : "Your turn")
        : "AI thinking...");

  // Move pairs for display
  const movePairs: { num: number; white: string; black?: string }[] = [];
  for (let i = 0; i < moveHistory.length; i += 2) {
    movePairs.push({
      num: Math.floor(i / 2) + 1,
      white: moveHistory[i].algebraic,
      black: moveHistory[i + 1]?.algebraic,
    });
  }

  // Promotion picker position
  const promoPickerStyle = promotionPending
    ? (() => {
        const [row, col] = toRowCol(promotionPending.to);
        const top = row * squareSize;
        const left = col * squareSize;
        return { top, left };
      })()
    : null;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
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
          fontFamily: FONT_UI,
          flexShrink: 0,
        }}
      >
        <span>
          Move {gameState.fullMoveNumber}
        </span>
        <span style={{ fontSize: 11 }}>
          {turnLabel}
        </span>
        <span style={{ fontSize: 10, color: "var(--ezy-text-muted)" }}>
          {difficulty}
        </span>
      </div>

      {/* Main area */}
      <div style={{
        flex: 1,
        display: "flex",
        flexDirection: isCompact ? "column" : "row",
        overflow: "hidden",
        position: "relative",
      }}>
        {/* Board */}
        <div style={{
          flex: isCompact ? undefined : 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 10,
          position: "relative",
          minHeight: isCompact ? actualBoardSize + 20 : undefined,
        }}>
          <div style={{ position: "relative", width: actualBoardSize, height: actualBoardSize }}>
            {/* Board grid */}
            <div style={{
              display: "grid",
              gridTemplateColumns: `repeat(8, ${squareSize}px)`,
              gridTemplateRows: `repeat(8, ${squareSize}px)`,
              position: "relative",
            }}>
              {Array.from({ length: 64 }, (_, idx) => {
                const [row, col] = toRowCol(idx);
                const isLight = (row + col) % 2 === 0;
                const piece = gameState.board[idx];
                const isSelected = selectedSquare === idx;
                const isLegalTarget = legalMovesForSelected.includes(idx);
                const isCursor = cursorSquare === idx;
                const isLastMoveSquare = lastMove && (lastMove.from === idx || lastMove.to === idx);
                const isKingCheck = kingInCheck === idx;
                let bgColor = isLight ? "var(--ezy-surface-raised)" : "var(--ezy-surface)";
                if (isLastMoveSquare) {
                  bgColor = isLight
                    ? "color-mix(in srgb, var(--ezy-accent) 12%, var(--ezy-surface-raised))"
                    : "color-mix(in srgb, var(--ezy-accent) 15%, var(--ezy-surface))";
                }
                if (isKingCheck) {
                  bgColor = "rgba(248,113,113,0.3)";
                }

                return (
                  <div
                    key={idx}
                    onClick={() => handleSquareClick(idx)}
                    style={{
                      width: squareSize,
                      height: squareSize,
                      backgroundColor: bgColor,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      position: "relative",
                      cursor: "pointer",
                      outline: isSelected
                        ? "2px solid var(--ezy-accent)"
                        : isCursor
                          ? "2px solid var(--ezy-text-muted)"
                          : "none",
                      outlineOffset: isSelected || isCursor ? "-2px" : undefined,
                    }}
                  >
                    {/* Rank label on left edge */}
                    {col === 0 && (
                      <span style={{
                        position: "absolute",
                        top: 1,
                        left: 2,
                        fontSize: 9,
                        color: "var(--ezy-text-muted)",
                        opacity: 0.5,
                        lineHeight: 1,
                        userSelect: "none",
                        fontFamily: FONT_UI,
                      }}>
                        {8 - row}
                      </span>
                    )}

                    {/* File label on bottom edge */}
                    {row === 7 && (
                      <span style={{
                        position: "absolute",
                        bottom: 1,
                        right: 2,
                        fontSize: 9,
                        color: "var(--ezy-text-muted)",
                        opacity: 0.5,
                        lineHeight: 1,
                        userSelect: "none",
                        fontFamily: FONT_UI,
                      }}>
                        {FILES[col]}
                      </span>
                    )}

                    {/* Legal move indicator (empty squares only) */}
                    {isLegalTarget && !piece && (
                      <div style={{
                        position: "absolute",
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        backgroundColor: "var(--ezy-accent)",
                        opacity: 0.4,
                      }} />
                    )}

                    {/* Piece */}
                    {piece && !(animating && animating.to === idx) && (
                      <span
                        style={{
                          fontSize: squareSize * 0.7,
                          lineHeight: 1,
                          color: piece.color === "w" ? "var(--ezy-text)" : "#1a1a1a",
                          WebkitTextStroke: piece.color === "b" ? "0.5px var(--ezy-text-muted)" : undefined,
                          textShadow: piece.color === "b" ? "0 0 2px rgba(255,255,255,0.15)" : undefined,
                          filter: piece.color === "b" ? "drop-shadow(0 1px 1px rgba(255,255,255,0.08))" : undefined,
                          userSelect: "none",
                          pointerEvents: "none",
                          position: "relative",
                          zIndex: 1,
                          opacity: (animating && animating.from === idx) ? 0 : 1,
                        }}
                      >
                        {PIECE_UNICODE[piece.color][piece.type]}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Animated piece overlay */}
            {animating && (
              <span
                style={{
                  position: "absolute",
                  left: animating.fromX,
                  top: animating.fromY,
                  width: squareSize,
                  height: squareSize,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: squareSize * 0.7,
                  lineHeight: 1,
                  color: animating.piece.color === "w" ? "var(--ezy-text)" : "#1a1a1a",
                  WebkitTextStroke: animating.piece.color === "b" ? "0.5px var(--ezy-text-muted)" : undefined,
                  textShadow: animating.piece.color === "b" ? "0 0 2px rgba(255,255,255,0.15)" : undefined,
                  filter: animating.piece.color === "b" ? "drop-shadow(0 1px 1px rgba(255,255,255,0.08))" : undefined,
                  userSelect: "none",
                  pointerEvents: "none",
                  zIndex: 10,
                  transition: `left ${ANIM_MS}ms cubic-bezier(0.2, 0, 0, 1), top ${ANIM_MS}ms cubic-bezier(0.2, 0, 0, 1)`,
                }}
              >
                {PIECE_UNICODE[animating.piece.color][animating.piece.type]}
              </span>
            )}

            {/* Promotion picker overlay */}
            {promotionPending && promoPickerStyle && (
              <div style={{
                position: "absolute",
                top: promoPickerStyle.top,
                left: promoPickerStyle.left,
                display: "flex",
                flexDirection: "column",
                backgroundColor: "var(--ezy-surface)",
                border: "1px solid var(--ezy-border)",
                borderRadius: 4,
                overflow: "hidden",
                zIndex: 20,
                boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
              }}>
                {(["Q", "R", "B", "N"] as PieceType[]).map((pt) => (
                  <div
                    key={pt}
                    onClick={() => handlePromotion(pt)}
                    style={{
                      width: squareSize,
                      height: squareSize,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      fontSize: squareSize * 0.65,
                      lineHeight: 1,
                      color: "var(--ezy-text)",
                      transition: "background-color 100ms ease",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "var(--ezy-surface-raised)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                  >
                    {PIECE_UNICODE["w"][pt]}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Move history panel */}
        <div style={{
          width: isCompact ? "100%" : movePanelWidth,
          maxHeight: isCompact ? 120 : undefined,
          borderLeft: isCompact ? "none" : "1px solid var(--ezy-border)",
          borderTop: isCompact ? "1px solid var(--ezy-border)" : "none",
          backgroundColor: "var(--ezy-surface)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
        }}>
          <div style={{
            padding: "6px 8px 4px",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--ezy-text-secondary)",
            fontFamily: FONT_UI,
            borderBottom: "1px solid var(--ezy-border)",
            flexShrink: 0,
          }}>
            Moves
          </div>
          <div
            ref={moveListRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "4px 6px",
            }}
          >
            {movePairs.map((pair, i) => {
              const isLast = i === movePairs.length - 1;
              return (
                <div
                  key={pair.num}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 2,
                    fontSize: 13,
                    fontFamily: FONT_UI,
                    fontVariantNumeric: "tabular-nums",
                    padding: "3px 4px",
                    borderRadius: 3,
                    backgroundColor: isLast ? "color-mix(in srgb, var(--ezy-accent) 10%, transparent)" : "transparent",
                  }}
                >
                  <span style={{ color: "var(--ezy-text-muted)", minWidth: 20, textAlign: "right", fontSize: 11 }}>
                    {pair.num}.
                  </span>
                  <span style={{
                    minWidth: 48,
                    fontWeight: 600,
                    color: "var(--ezy-text)",
                  }}>
                    {pair.white}
                  </span>
                  <span style={{
                    minWidth: 48,
                    fontWeight: 500,
                    color: "var(--ezy-text-muted)",
                  }}>
                    {pair.black || ""}
                  </span>
                </div>
              );
            })}
            {movePairs.length === 0 && (
              <div style={{
                fontSize: 10,
                color: "var(--ezy-text-muted)",
                padding: "8px 4px",
                textAlign: "center",
                fontFamily: FONT_UI,
              }}>
                No moves yet
              </div>
            )}
          </div>
        </div>

        {/* Game over overlay */}
        {gameResult !== "playing" && (
          <div style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.75)",
            zIndex: 30,
            gap: 12,
          }}>
            <div style={{
              fontSize: 18,
              fontWeight: 700,
              fontFamily: FONT_UI,
              color: gameResult === "checkmate"
                ? (resultWinner === "w" ? "#4ade80" : "#f87171")
                : "var(--ezy-text-secondary)",
            }}>
              {gameResult === "checkmate"
                ? (resultWinner === "w" ? "Checkmate - You Win!" : "Checkmate - You Lose")
                : gameResult === "stalemate"
                  ? "Draw - Stalemate"
                  : gameResult === "draw50"
                    ? "Draw - 50-move rule"
                    : "Draw - Insufficient material"}
            </div>
            <div style={{ fontSize: 12, color: "var(--ezy-text-muted)", fontFamily: FONT_UI }}>
              {moveHistory.length} moves played
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button
                onClick={() => startGame(difficulty!)}
                style={{
                  padding: "8px 16px",
                  borderRadius: 6,
                  border: "none",
                  backgroundColor: "var(--ezy-accent)",
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: FONT_UI,
                  opacity: 1,
                  transition: "opacity 150ms ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.85"; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
              >
                Play Again
              </button>
              <button
                onClick={resetToSelect}
                style={{
                  padding: "8px 16px",
                  borderRadius: 6,
                  border: "1px solid var(--ezy-border)",
                  backgroundColor: "var(--ezy-surface)",
                  color: "var(--ezy-text-secondary)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: FONT_UI,
                  opacity: 1,
                  transition: "opacity 150ms ease",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.85"; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
              >
                Change Difficulty
              </button>
            </div>
          </div>
        )}

        {/* Pause overlay */}
        {paused && gameResult === "playing" && (
          <div style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.6)",
            zIndex: 30,
          }}>
            <div style={{
              fontSize: 18,
              fontWeight: 700,
              color: "var(--ezy-text-secondary)",
              fontFamily: FONT_UI,
            }}>
              Paused
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

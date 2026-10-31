"""Standard algebraic notation for the move log."""

from game.chess.moves import in_check, legal_moves
from game.chess.position import Move, Position, square_name


def san(before: Position, move: Move, after: Position) -> str:
    """`"Nf3"`, `"exd5"`, `"O-O"`, `"e8=Q+"`, `"Qh4#"` (no file/rank disambiguation)."""
    if move.castle:
        text = "O-O" if move.castle == "K" else "O-O-O"
    else:
        kind = before.board[move.origin].lower()
        capture = bool(before.board[move.target]) or move.en_passant
        if kind == "p":
            prefix = square_name(move.origin)[0] if capture else ""
        else:
            prefix = kind.upper()
        text = prefix + ("x" if capture else "") + square_name(move.target)
        if move.promotion:
            text += "=" + move.promotion.upper()
    if in_check(after):
        text += "+" if legal_moves(after) else "#"
    return text

"""How a game of chess ends."""

from enum import Enum

from game.chess.moves import in_check, legal_moves
from game.chess.position import Position, file_of, rank_of


class Ending(Enum):
    CHECKMATE = "checkmate"
    STALEMATE = "stalemate"
    INSUFFICIENT_MATERIAL = "insufficient_material"
    FIFTY_MOVES = "fifty_moves"
    REPETITION = "repetition"
    RESIGNATION = "resignation"


def ending_of(
    position: Position,
    history: list[str],
    *,
    fifty_move_plies: int,
    repetitions: int,
    dead_positions: bool,
) -> Ending | None:
    """The ending reached in `position`, or None if play goes on.

    history          -- `Position.key()` of every position so far, this one included
    dead_positions   -- whether insufficient material is an automatic draw
    """
    if not legal_moves(position):
        return Ending.CHECKMATE if in_check(position) else Ending.STALEMATE
    if dead_positions and insufficient_material(position.board):
        return Ending.INSUFFICIENT_MATERIAL
    if position.halfmove_clock >= fifty_move_plies:
        return Ending.FIFTY_MOVES
    if history.count(position.key()) >= repetitions:
        return Ending.REPETITION
    return None


def insufficient_material(board: tuple[str, ...]) -> bool:
    """Neither side can ever mate: bare kings, a lone minor piece, or bishops that
    all stand on one square colour. Two knights or bishop + knight can still mate
    with help, so play continues."""
    knights = 0
    bishop_squares = []
    for sq, piece in enumerate(board):
        kind = piece.lower()
        if kind in ("p", "r", "q"):
            return False
        if kind == "n":
            knights += 1
        elif kind == "b":
            bishop_squares.append(sq)
    if knights:
        return knights == 1 and not bishop_squares
    shades = {(file_of(sq) + rank_of(sq)) % 2 for sq in bishop_squares}
    return len(shades) <= 1

"""Static evaluation: material plus piece-square tables, in centipawns."""

from dataclasses import dataclass

from game.chess.position import color_of, file_of, rank_of, square


@dataclass(frozen=True)
class Weights:
    """What one player knows about chess positions."""
    values: dict[str, int]
    """Centipawns per piece kind ("p", "n", "b", "r", "q", "k")."""
    tables: dict[str, list[int]]
    """Per-kind bonus for each square, from white's side (index 0 = a1)."""
    positional: float
    """How much of the tables this player understands; 0 = pure material."""


def evaluate(board: tuple[str, ...], weights: Weights) -> float:
    """White-positive score of a board."""
    score = 0.0
    for sq, piece in enumerate(board):
        if not piece:
            continue
        kind = piece.lower()
        seen_from = sq if piece.isupper() else square(file_of(sq), 7 - rank_of(sq))
        value = weights.values[kind] + weights.positional * weights.tables[kind][seen_from]
        score += value if piece.isupper() else -value
    return score


def material(board: tuple[str, ...], color: str, values: dict[str, int]) -> int:
    return sum(values[piece.lower()] for piece in board if piece and color_of(piece) == color)

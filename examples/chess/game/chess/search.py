"""The computer opponent's search: iterative-deepening negamax with alpha-beta
pruning under a node budget.

The budget is what keeps a deep search from freezing a frame: when it runs out,
the search stops and the move from the deepest *completed* depth is played.
"""

from dataclasses import dataclass

from game.chess.evaluate import Weights, evaluate
from game.chess.moves import in_check, legal_moves, play
from game.chess.position import WHITE, Move, Position

MATE = 1_000_000
INFINITY = MATE * 4


@dataclass(frozen=True)
class Style:
    depth: int
    """Deepest search, in plies."""
    weights: Weights
    aggression: float
    """Extra pull toward captures when ordering moves."""


@dataclass
class _Budget:
    nodes_left: int


class _OutOfNodes(Exception):
    pass


def best_move(position: Position, moves: list[Move], style: Style, node_budget: int) -> Move:
    """The best of `moves` (the legal moves in `position`) for the side to move."""
    ordered = _ordered(position, moves, style)
    best = ordered[0]
    budget = _Budget(node_budget)
    for depth in range(1, style.depth + 1):
        try:
            best = _search_root(position, ordered, depth, style, budget)
        except _OutOfNodes:
            break
        ordered = [best] + [move for move in ordered if move != best]
    return best


def _search_root(position: Position, moves: list[Move], depth: int, style: Style, budget: _Budget) -> Move:
    best, alpha = moves[0], -INFINITY
    for move in moves:
        score = -_negamax(play(position, move), depth - 1, -INFINITY, -alpha, style, budget)
        if score > alpha:
            best, alpha = move, score
    return best


def _negamax(position: Position, depth: int, alpha: float, beta: float, style: Style, budget: _Budget) -> float:
    """Score of `position` for the side to move."""
    budget.nodes_left -= 1
    if budget.nodes_left < 0:
        raise _OutOfNodes()
    moves = legal_moves(position)
    if not moves:
        return -(MATE + depth) if in_check(position) else 0
    if depth == 0:
        score = evaluate(position.board, style.weights)
        return score if position.turn == WHITE else -score
    for move in _ordered(position, moves, style):
        alpha = max(alpha, -_negamax(play(position, move), depth - 1, -beta, -alpha, style, budget))
        if alpha >= beta:
            break
    return alpha


def _ordered(position: Position, moves: list[Move], style: Style) -> list[Move]:
    """Most promising first, which is what makes alpha-beta prune: captures of the
    most valuable victim, then promotions, then castling."""
    def promise(move: Move) -> float:
        victim = position.board[move.target]
        if victim:
            return 10_000 + style.weights.values[victim.lower()] * (1 + style.aggression)
        if move.promotion:
            return 9_000
        return 500 if move.castle else 0
    return sorted(moves, key=promise, reverse=True)

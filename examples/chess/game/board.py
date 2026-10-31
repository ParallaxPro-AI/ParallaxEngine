"""Where the board sits in the world, who sits at it, and the game phases
systems and panels are scoped by.

The board entity (`Placed.board`) carries an 8×8 `Grid` with `row_order="up"`,
so its cell (col, row) is (file, rank) and a1 is `Cell(0, 0)` — exactly
`game.chess.position.cell_of`.
"""

from parallax import Vec2
from parallax.grid import Grid
from project import Placed

from game.chess.position import BLACK, WHITE, Position, cell_of
from game.resources import Match

HUMAN = WHITE
COMPUTER = BLACK


def board(ctx) -> Grid:
    return ctx.world.placed(Placed.board).get(Grid)


def center(ctx, sq: int) -> Vec2:
    """Where a square is drawn. A 2D point, so spawns take each prefab's `"z"`."""
    return board(ctx).center(cell_of(sq)).xy()


def position(ctx) -> Position:
    """The position on the board, read from `Match.fen`."""
    return Position.from_fen(ctx.get(Match).fen)


def in_play(ctx) -> bool:
    return ctx.get(Match).ending is None


def human_to_move(ctx) -> bool:
    return in_play(ctx) and position(ctx).turn == HUMAN

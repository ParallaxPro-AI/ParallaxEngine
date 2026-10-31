"""Where the well sits in the world, who drops which colour, and the game phases
systems and panels are scoped by.

The well entity (`Placed.well`) carries a `Grid` with `row_order="up"`, so its
cells are exactly the rules' `Cell(col, row)` with row 0 at the bottom.
"""

from parallax import Vec2, Vec3
from parallax.grid import Grid
from parallax.values import Cell
from project import Placed

from game.config import Rules
from game.resources import Match
from game.well import Disc, turn

HUMAN = Disc.AMBER
COMPUTER = Disc.TEAL


def well(ctx) -> Grid:
    return ctx.world.placed(Placed.well).get(Grid)


def slot(ctx, cell: Cell) -> Vec2:
    """Where a disc in `cell` is drawn. A 2D point, so spawns take each prefab's `"z"`."""
    return well(ctx).center(cell).xy()


def column_at(ctx, point: Vec3) -> int | None:
    """The column a pointer is aiming at: anywhere over the well or the drop lane
    above it, but not the empty screen below or far above (where HUD cards sit)."""
    rules = ctx.config(Rules)
    if not rules.aim_bottom <= point.y <= rules.aim_top:
        return None
    grid = well(ctx)
    aimed = grid.cell_at(point.with_y(grid.center(Cell(0, 0)).y))
    return aimed.col if aimed is not None else None


def in_play(ctx) -> bool:
    return ctx.get(Match).result is None


def human_to_drop(ctx) -> bool:
    return in_play(ctx) and turn(ctx.get(Match).cells) is HUMAN

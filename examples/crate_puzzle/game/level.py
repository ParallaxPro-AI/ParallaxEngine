"""The current level: its content entry, the yard's grid, and the yard as it stands."""

from parallax import Context, Tag, World
from parallax.grid import Grid, GridCell
from parallax.values import Cell
from project import Placed

from game.components import Bot, Crate, Pad, Wall
from game.content import LevelDef
from game.resources import Shift
from game.sokoban import Yard


def yard_grid(world: World) -> Grid:
    return world.placed(Placed.yard).get(Grid)


def level_count(ctx: Context) -> int:
    return len(ctx.content(LevelDef))


def current_level(ctx: Context) -> LevelDef:
    return ctx.content(LevelDef)[ctx.get(Shift).level_index].data


def is_final_level(ctx: Context) -> bool:
    return ctx.get(Shift).level_index == level_count(ctx) - 1


def cells(world: World, tagged: Tag) -> frozenset[Cell]:
    return frozenset(place.cell for _, place in world.query(GridCell, tagged=tagged))


def yard_of(world: World) -> Yard:
    """The pure rules' view of the pieces on the grid."""
    bot = world.query(tagged=Bot).single().get(GridCell).cell
    return Yard(walls=cells(world, Wall), pads=cells(world, Pad), crates=cells(world, Crate), bot=bot)

"""The board as entities: its grid, the tiles on it, and new tiles."""

import random

from parallax import Context, Entity, World
from parallax.grid import Grid, GridCell
from parallax.values import Cell
from project import Placed, Prefabs

from game.components import Tile
from game.config import Rules
from game.content import TileDef
from game.slide_logic import Tiles


def board_grid(world: World) -> Grid:
    return world.placed(Placed.board).get(Grid)


def tiles_by_cell(world: World) -> dict[Cell, Entity]:
    return {place.cell: entity for entity, _, place in world.query(Tile, GridCell)}


def values(tiles: dict[Cell, Entity]) -> Tiles:
    return {cell: entity.get(Tile).value for cell, entity in tiles.items()}


def spawn_tile(ctx: Context, grid: Grid, cell: Cell) -> Entity:
    """A new 2 (or, now and then, a 4) on `cell`."""
    value = 4 if random.random() < ctx.config(Rules).four_chance else 2
    return ctx.world.spawn(Prefabs.tile, at=grid.center(cell).xy(),
                           components=[Tile(value=value), GridCell(cell=cell)])


def tile_def(ctx: Context, value: int) -> TileDef:
    return ctx.content(TileDef).first(lambda tile: tile.value == value).data

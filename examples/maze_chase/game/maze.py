"""The maze on the grid plugin: laying the ASCII layout onto a `Grid`, and the few
questions movers ask about it. Moving from cell to cell is the plugin's `GridMover`."""

from parallax import Context, Entity, Vec2, vec2
from parallax.grid import Grid, GridCell, GridMover
from parallax.values import Cell

from game.components import Home, Wall
from game.content import MazeDef

STEPS = (Cell.UP, Cell.DOWN, Cell.LEFT, Cell.RIGHT)

FACING = {Cell.RIGHT: 0.0, Cell.UP: 90.0, Cell.LEFT: 180.0, Cell.DOWN: -90.0}
"""Sprite angle for each heading (the art faces right)."""


def layout(maze: MazeDef) -> Grid:
    """A grid exactly the size of the ASCII maze, centred on its entity, row 0 on top."""
    return Grid(cols=len(maze.rows[0]), rows=len(maze.rows), cell_size=vec2(maze.tile, maze.tile))


def cells(tiles: dict[Cell, str], symbols: str) -> list[Cell]:
    """Every cell of a parsed layout (`Grid.parse`) holding one of `symbols`."""
    return [cell for cell, symbol in tiles.items() if symbol in symbols]


def board(ctx: Context) -> Grid:
    _, grid = ctx.world.query(Grid).single()
    return grid


def is_open(grid: Grid, cell: Cell) -> bool:
    return grid.contains(cell) and grid.first_at(cell, tagged=Wall) is None


def heading_of(stick: Vec2) -> Cell:
    """The grid direction a stick points in most."""
    if abs(stick.x) >= abs(stick.y):
        return Cell.RIGHT if stick.x > 0 else Cell.LEFT
    return Cell.UP if stick.y > 0 else Cell.DOWN


def send_home(grid: Grid, entity: Entity) -> None:
    """Stop a mover and put it back on its start cell. Assigning a `Vec2` keeps the
    prefab's draw depth."""
    entity.get(GridMover).stop()
    home = entity.get(Home).cell
    entity.get(GridCell).cell = home
    entity.transform.position = grid.center(home).xy()

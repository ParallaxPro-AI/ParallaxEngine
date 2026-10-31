"""The board as entities: its grid, the gems on it, the pure rules' view of them, and
the two things the player can ask of it (is it busy, where is a legal swap)."""

from parallax import Context, ContentRef, Entity, World
from parallax.grid import Grid, GridCell
from parallax.values import Cell
from project import Placed, Prefabs

from game.components import Gem
from game.content import GemDef
from game.match_logic import Board, Special, find_swap
from game.resources import BoardState


def board_grid(world: World) -> Grid:
    return world.placed(Placed.board).get(Grid)


def gems_by_cell(world: World) -> dict[Cell, Entity]:
    return {place.cell: entity for entity, _, place in world.query(Gem, GridCell)}


def board_of(grid: Grid, gems: dict[Cell, Entity]) -> Board:
    return Board(grid.cols, grid.rows, {cell: gem.get(Gem).kind.id for cell, gem in gems.items()})


def specials_of(gems: dict[Cell, Entity]) -> dict[Cell, Special]:
    return {cell: gem.get(Gem).special for cell, gem in gems.items()}


def spawn_gem(ctx: Context, grid: Grid, kind: ContentRef[GemDef], cell: Cell, *, drop: int = 0) -> Entity:
    """A gem belonging to `cell`, drawn `drop` rows higher (so it can fall in)."""
    return ctx.world.spawn(Prefabs.gem, at=grid.center(cell + Cell.UP * drop).xy(),
                           components=[Gem(kind=kind), GridCell(cell=cell)])


def busy(ctx: Context) -> bool:
    """Whether a swap is still playing out."""
    resolving = ctx.get(BoardState).resolving
    return resolving is not None and resolving.active


def show_hint(ctx: Context) -> None:
    """Point out a legal swap (the HUD's Hint button, and the idle timer)."""
    if busy(ctx):
        return
    board = ctx.get(BoardState)
    swap = find_swap(board_of(board_grid(ctx.world), gems_by_cell(ctx.world)))
    board.selected = None
    board.hint = list(swap) if swap else []

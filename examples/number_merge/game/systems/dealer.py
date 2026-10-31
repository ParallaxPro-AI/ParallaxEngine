import random

from parallax import System, system
from parallax.grid import GridCell
from project import Prefabs, Scenes

from game.board import board_grid, spawn_tile
from game.components import Tile
from game.config import Rules
from game.events import BoardDealt
from game.resources import Records, Score


@system("wells", scenes=[Scenes.title, Scenes.board])
class Wells(System):
    """An empty well under every cell, so the board reads as a 4x4 grid even when it is
    empty (behind the title card, too)."""

    def start(self, ctx):
        for cell in board_grid(ctx.world).cells():
            ctx.world.spawn(Prefabs.well, components=[GridCell(cell=cell, snap=True)])


@system("dealer", scenes=[Scenes.title, Scenes.board])
class Dealer(System):
    """Deals a fresh game each time the board scene loads: the starting tiles in random
    cells. The title deals one too, so its card sits over a live-looking board as the
    template's does (Play then deals a new one)."""

    def start(self, ctx):
        grid = board_grid(ctx.world)
        score = ctx.get(Score)
        for cell in random.sample(list(grid.cells()), ctx.config(Rules).start_tiles):
            tile = spawn_tile(ctx, grid, cell)
            score.highest = max(score.highest, tile.get(Tile).value)
        score.best_before = ctx.get(Records).best_score
        ctx.emit(BoardDealt())

import random

from parallax import System, system
from parallax.grid import GridCell
from project import Prefabs, Scenes

from game.board import board_grid, spawn_gem
from game.components import Crust, Gem
from game.config import Rules
from game.content import GemDef
from game.descent import current_stage, mods
from game.match_logic import Special, deal
from game.resources import BoardState, Records, Run

CRUSTED = "#"


@system("dealer", scenes=[Scenes.board, Scenes.title])
class Dealer(System):
    """Deals the current stage each time the board scene loads: a socket under every
    cell, a playable board of the stage's gem kinds, its crust, and any specials the
    relics seed. Every stage starts from a fresh load of the scene, so nothing from the
    last one survives. The title scene gets a dealt board too, shown behind its card."""

    def start(self, ctx):
        run = ctx.get(Run)
        stage = current_stage(ctx)
        bonus = mods(run)
        grid = board_grid(ctx.world)
        for cell in grid.cells():
            ctx.world.spawn(Prefabs.cell_socket, components=[GridCell(cell=cell, snap=True)])

        in_play = max(ctx.config(Rules).min_gem_kinds, stage.gem_kinds - bonus.fewer_kinds)
        kinds = list(ctx.content(GemDef))[:in_play]
        by_id = {kind.id: kind for kind in kinds}
        dealt = deal(grid.cols, grid.rows, list(by_id))
        gems = {cell: spawn_gem(ctx, grid, by_id[kind], cell) for cell, kind in dealt.kinds.items()}

        seeded = [Special.BOMB] * bonus.start_bombs + [Special.LINE] * bonus.start_lines
        for cell, special in zip(random.sample(list(gems), len(seeded)), seeded):
            gems[cell].get(Gem).special = special

        for cell, mark in grid.parse(stage.crust).items():
            if mark == CRUSTED:
                ctx.world.spawn(Prefabs.crust, components=[Crust(layers=stage.crust_layers),
                                                           GridCell(cell=cell, snap=True)])

        ctx.get(BoardState).kinds = kinds
        run.moves_left = stage.moves + bonus.extra_moves
        run.stage_score = 0
        if run.stage_index == 0:
            run.best_before = ctx.get(Records).best_run

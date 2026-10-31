from parallax import System, on, system
from parallax.grid import Grid, GridCell
from project import Prefabs, Scenes

from game.components import Home, Stalker
from game.config import Rules
from game.content import StalkerDef
from game.events import GobblerCaught, LevelCleared, PipEaten, RoundStarted
from game.maze import board, cells, layout
from game.progress import is_final_level, lives_left
from game.resources import Board, Run


@system("levels", scenes=[Scenes.title, Scenes.maze])
class Levels(System):
    """Lays the ASCII maze onto a grid, fills it with pips for every level, counts
    them down, and starts each round with a READY freeze (the HUD shows the splash).
    It builds the maze behind the title card too, frozen there by the modal title."""

    def start(self, ctx):
        self.build(ctx)
        self.start_level(ctx)

    def update(self, ctx, dt):
        board_state = ctx.get(Board)
        if board_state.ready.done:
            board_state.clock += dt
        else:
            board_state.ready.tick(dt)

    @on(PipEaten)
    def pip_eaten(self, ctx, event: PipEaten):
        board_state = ctx.get(Board)
        board_state.pips_left -= 1
        if board_state.pips_left == 0:
            ctx.emit(LevelCleared(final=is_final_level(ctx), seconds=board_state.clock))

    @on(LevelCleared, where=lambda event: not event.final)
    def level_cleared(self, ctx, event: LevelCleared):
        ctx.get(Run).level_index += 1
        self.start_level(ctx)

    @on(GobblerCaught)
    def caught(self, ctx, event: GobblerCaught):
        if lives_left(ctx) > 0:
            self.start_round(ctx)

    def build(self, ctx):
        """The grid, its walls, the Gobbler and the Stalkers. They stay for the whole run."""
        maze = ctx.config(Rules).maze.data
        grid = ctx.world.spawn(Prefabs.board, components=[layout(maze)]).get(Grid)
        tiles = grid.parse(maze.rows)
        for cell in cells(tiles, "#"):
            ctx.world.spawn(Prefabs.wall, components=[GridCell(cell=cell, snap=True)])
        ctx.get(Board).door = cells(tiles, "-")[0]

        self.spawn_mover(ctx, grid, Prefabs.gobbler, cells(tiles, "P")[0])
        for kind in ctx.content(StalkerDef):
            home = cells(tiles, str(kind.data.number))[0]
            self.spawn_mover(ctx, grid, Prefabs.stalker, home, Stalker(kind=kind))

    def spawn_mover(self, ctx, grid: Grid, prefab, home, *extra):
        """A piece that walks the maze, standing on its home cell at its prefab's depth."""
        ctx.world.spawn(prefab, at=grid.center(home).xy(),
                        components=[GridCell(cell=home), Home(cell=home), *extra])

    def start_level(self, ctx):
        tiles = board(ctx).parse(ctx.config(Rules).maze.data.rows)
        for cell in cells(tiles, "."):
            ctx.world.spawn(Prefabs.pip, components=[GridCell(cell=cell, snap=True)])
        for cell in cells(tiles, "o"):
            ctx.world.spawn(Prefabs.flare, components=[GridCell(cell=cell, snap=True)])
        board_state = ctx.get(Board)
        board_state.pips_left = len(cells(tiles, ".o"))
        board_state.clock = 0.0
        self.start_round(ctx)

    def start_round(self, ctx):
        ctx.get(Board).ready.restart(ctx.config(Rules).ready_seconds)
        ctx.emit(RoundStarted())

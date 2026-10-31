from parallax import Behavior, Sprite, behavior, on, state
from parallax.grid import CellEntered, GridCell, GridMover
from parallax.values import Cell

from game.actions import Controls
from game.components import Flare, Home, Pip
from game.events import PipEaten, RoundStarted
from game.maze import FACING, board, heading_of, is_open, send_home
from game.progress import getting_ready


@behavior("gobbler", requires=[GridCell, GridMover, Home, Sprite])
class GobblerControl(Behavior):
    """The player. Its `GridMover` runs it down the corridors cell to cell; this takes
    the next opening in the last direction pressed and eats whatever lies in each
    cell it reaches. The mouth chomps while it moves and faces where it's going.

    It reads the stick even during the READY freeze, so a direction pressed early is
    taken the moment play starts; only setting off waits for READY to end."""

    wanted: Cell | None = state(None, doc="Last direction pressed; taken at the next opening.")

    def update(self, ctx, dt):
        stick = ctx.input.axis(Controls.move)
        if stick.length() > 0:
            self.wanted = heading_of(stick)
        if not self.entity.get(GridMover).moving and not getting_ready(ctx):
            self.steer(ctx)
        self.animate()

    @on(CellEntered)
    def reached(self, ctx, event: CellEntered):
        self.eat(ctx, event.cell)
        self.steer(ctx)

    @on(RoundStarted)
    def round_started(self, ctx, event: RoundStarted):
        self.wanted = None
        send_home(board(ctx), self.entity)
        self.animate()

    def steer(self, ctx):
        """Turn into the wanted direction if it's open from here. Otherwise the mover
        keeps its heading and stops by itself at a wall."""
        here = self.entity.get(GridCell).cell
        if self.wanted is not None and is_open(board(ctx), here + self.wanted):
            self.entity.get(GridMover).go(self.wanted)

    def eat(self, ctx, cell: Cell):
        pip = board(ctx).first_at(cell, tagged=Pip)
        if pip:
            ctx.emit(PipEaten(flare=pip.has(Flare), at=pip.transform.position))
            pip.destroy()

    def animate(self):
        mover = self.entity.get(GridMover)
        sprite = self.entity.get(Sprite)
        if not mover.moving:
            sprite.play("idle")
            return
        sprite.play("chomp")
        self.entity.transform.angle = FACING[mover.direction]

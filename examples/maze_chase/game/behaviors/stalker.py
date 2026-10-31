import random

from parallax import Behavior, Color, Sprite, behavior, on, param
from parallax.grid import CellEntered, GridCell, GridMover
from parallax.values import Cell

from game.components import Gobbler, Home, Stalker
from game.config import PaceTuning
from game.events import RoundStarted
from game.maze import STEPS, board, is_open, send_home
from game.progress import current_level, getting_ready, knob, stalker_mode
from game.resources import Board, Hunt, Mode


@behavior("stalker", requires=[GridCell, GridMover, Home, Stalker, Sprite],
          when=lambda ctx: not getting_ready(ctx))
class StalkerBrain(Behavior):
    """One hunter. On every cell it reaches it takes the open, non-reversing turn that
    brings it closest to its target: its corner in scatter mode, a cell near the
    Gobbler in chase mode (each Stalker's lead differs), the ghost-house door once
    eaten. While frightened it turns at random. That one greedy rule produces all four
    personalities. It sits still through the READY freeze (`when=`); its `GridMover`
    does the moving."""

    speed: float = param(4.7, unit="cells/s")
    frightened_speed: float = param(3.0, unit="cells/s")
    eaten_speed: float = param(9.5, unit="cells/s")
    frightened_color: Color = param(Color.hex("#3d5cf2"))
    warning_color: Color = param(Color.hex("#e6ebff"), doc="Flashes as the fright runs out.")
    eaten_color: Color = param(Color.hex("#8c99bf").with_alpha(0.4))
    warning_seconds: float = param(1.6, unit="s")
    flashes_per_second: float = param(3.0)

    def update(self, ctx, dt):
        mover = self.entity.get(GridMover)
        mode = stalker_mode(ctx, self.entity.get(Stalker))
        mover.speed = self.speed_in(ctx, mode)
        if not mover.moving:  # a fresh round: leave the start cell upward
            mover.go(Cell.UP)
        self.tint(ctx, mode)

    @on(CellEntered)
    def reached(self, ctx, event: CellEntered):
        stalker = self.entity.get(Stalker)
        if stalker.eaten and event.cell == ctx.get(Board).door:
            stalker.eaten = False
        self.turn(ctx, event.cell, stalker_mode(ctx, stalker))

    @on(RoundStarted, always=True)
    def round_started(self, ctx, event: RoundStarted):
        self.entity.get(Stalker).eaten = False
        send_home(board(ctx), self.entity)

    def speed_in(self, ctx, mode: Mode) -> float:
        if mode is Mode.EATEN:
            return self.eaten_speed
        base = self.frightened_speed if mode is Mode.FRIGHTENED else self.speed
        return base * current_level(ctx).stalker_speed * knob(ctx, ctx.config(PaceTuning).stalker_speed)

    def turn(self, ctx, cell: Cell, mode: Mode):
        grid = board(ctx)
        mover = self.entity.get(GridMover)
        open_steps = [step for step in STEPS if is_open(grid, cell + step)]
        choices = [step for step in open_steps if step != mover.direction * -1] or open_steps
        if mode is Mode.FRIGHTENED:
            mover.go(random.choice(choices))
            return
        target = self.target(ctx, cell, mode)
        mover.go(min(choices, key=lambda step: distance_squared(cell + step, target)))

    def target(self, ctx, cell: Cell, mode: Mode) -> Cell:
        kind = self.entity.get(Stalker).kind.data
        if mode is Mode.EATEN:
            return ctx.get(Board).door
        if mode is Mode.SCATTER:
            return kind.corner
        _, prey, prey_mover = ctx.world.query(GridCell, GridMover, tagged=Gobbler).single()
        if kind.shy_within and cell.manhattan(prey.cell) <= kind.shy_within:
            return kind.corner
        if prey_mover.direction is None:
            return prey.cell
        return prey.cell + prey_mover.direction * kind.lead

    def tint(self, ctx, mode: Mode):
        sprite = self.entity.get(Sprite)
        if mode is Mode.EATEN:
            sprite.color = self.eaten_color
        elif mode is Mode.FRIGHTENED:
            left = ctx.get(Hunt).fright.remaining
            flashing = left < self.warning_seconds and int(left * self.flashes_per_second * 2) % 2 == 0
            sprite.color = self.warning_color if flashing else self.frightened_color
        else:
            sprite.color = self.entity.get(Stalker).kind.data.color


def distance_squared(a: Cell, b: Cell) -> int:
    d = a - b
    return d.col * d.col + d.row * d.row

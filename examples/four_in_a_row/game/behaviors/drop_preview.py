import math

from parallax import Behavior, Vec3, behavior, param

from game.board import column_at, human_to_drop, slot
from game.resources import Match
from game.well import landing


@behavior("drop_preview")
class DropPreview(Behavior):
    """Shows where the player's next disc would go: follows the column under the
    pointer while it is the player's drop, and hides otherwise.

    On the ghost disc (`snap_to_slot`) it sits in the landing slot and breathes;
    on the column glow it slides along x and keeps its placed height."""

    snap_to_slot: bool = param(False)
    breathe: float = param(0.0, min=0, doc="Scale swing of the breathing pulse (0.06 = ±6%).")
    breathe_period: float = param(1.6, min=0.1, unit="s")

    def update(self, ctx, dt):
        column = column_at(ctx, ctx.input.pointer.world)
        cell = landing(ctx.get(Match).cells, column) if column is not None else None
        shown = cell is not None and human_to_drop(ctx)
        self.entity.visible = shown
        if not shown:
            return

        transform = self.entity.transform
        target = slot(ctx, cell)
        transform.position = target if self.snap_to_slot else transform.position.with_x(target.x)
        pulse = 0.5 - 0.5 * math.cos(ctx.time.now / self.breathe_period * math.tau)
        transform.scale = Vec3.ONE * (1 + self.breathe * pulse)

"""Puts crumbled blocks back."""

from parallax import System, on, system

from game.components import Level
from game.config import Rules
from game.events import Crumbled
from game.resources import Attempt, Regrowth


@system("crumbles", scenes=[Level])
class Crumbles(System):
    """A crumble block can't restore itself once it's gone, so the level notes
    it in `Attempt.regrowing` and puts a fresh one back where it was after
    `crumble_respawn` seconds. The note is saved, so a save in between still
    brings the block back."""

    @on(Crumbled)
    def crumbled(self, ctx, event: Crumbled):
        due = ctx.time.now + ctx.config(Rules).crumble_respawn
        ctx.get(Attempt).regrowing.append(Regrowth(prefab=event.prefab, at=event.at, due=due))

    def update(self, ctx, dt):
        attempt = ctx.get(Attempt)
        for block in attempt.regrowing:
            if ctx.time.now >= block.due:
                ctx.world.spawn(block.prefab, at=block.at)
        attempt.regrowing = [block for block in attempt.regrowing if ctx.time.now < block.due]

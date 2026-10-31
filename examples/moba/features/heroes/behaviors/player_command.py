from parallax import Behavior, behavior
from parallax.combat import Health

from features.heroes.events import CastRequested, RankUpRequested, RecallRequested, WardRequested
from game.actions import ABILITY_KEYS, Controls


@behavior("player_command", requires=[Health])
class PlayerCommand(Behavior):
    """Turns the owning player's input into requests: Q/W/E/R cast toward the
    pointer, or rank the ability up while the rank-up key is held; ward and recall
    do what they say. Server only (they spend, spawn and damage); walking and
    attacking are PlayerOrders, which is predicted."""

    def update(self, ctx, dt):
        if self.entity.get(Health).dead:
            return
        pointer = ctx.input.pointer
        for slot, key in enumerate(ABILITY_KEYS):
            if ctx.input.pressed(key):
                if ctx.input.held(Controls.rank_up):
                    ctx.emit(RankUpRequested(hero=self.entity, slot=slot))
                else:
                    ctx.emit(CastRequested(hero=self.entity, slot=slot, aim=pointer.world))
        for key, kind in ((Controls.ward, "picket"), (Controls.watchfire, "watchfire"), (Controls.hushbell, "hushbell")):
            if ctx.input.pressed(key):
                ctx.emit(WardRequested(hero=self.entity, at=pointer.world, kind=kind))
        if ctx.input.pressed(Controls.recall):
            ctx.emit(RecallRequested(hero=self.entity))

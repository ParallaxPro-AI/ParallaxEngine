from parallax import Behavior, Color, behavior, on
from parallax.combat import Damaged

from game.rules import Sounds


@behavior("keeper_feedback")
class KeeperFeedback(Behavior):
    """Sells a hit on the keeper: a red flash, a shake and a grunt. The moment of mercy
    after each hit is the prefab's `Health.invulnerable_after_hit`."""

    @on(Damaged)
    def hurt(self, ctx, event: Damaged):
        ctx.ui.flash(self.entity, color=Color.RED, seconds=0.2)
        ctx.camera.main.shake(0.25, 0.18)
        ctx.audio.play(ctx.config(Sounds).hurt)

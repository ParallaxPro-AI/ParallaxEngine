from parallax import Behavior, TriggerEntered, behavior, on
from project import Text

from game.loot import drop_loot
from game.resources import Run
from game.rules import Rules, Sounds


@behavior("locked_chest")
class LockedChest(Behavior):
    """Spends a key to burst open and roll the chest loot table."""

    @on(TriggerEntered)
    def touched(self, ctx, event: TriggerEntered):
        run = ctx.get(Run)
        if run.keys == 0:
            ctx.ui.toast(Text.chest_locked)
            return
        run.keys -= 1
        ctx.audio.play(ctx.config(Sounds).relic, at=self.entity)
        drop_loot(ctx, ctx.config(Rules).chest_loot, self.entity.transform.position)
        self.entity.destroy()

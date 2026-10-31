from parallax import Color, System, on, system
from parallax.combat import Damaged, Died
from project import Assets, Placed, Scenes

from game.components import Breakable, Foe
from game.content import Effect
from game.effects import apply_effect
from game.events import BossSlain, ItemCollected
from game.loot import drop_loot
from game.resources import Run
from game.rules import Rules, Sounds


@system("spoils", scenes=[Scenes.cellar])
class Spoils(System):
    """Everything the keeper gains: picked-up, bought and drafted items take effect here,
    and fallen foes leave their drops (elites their own table; bosses take their brood).
    Shattered barrels, crates and bone piles sometimes leave a coin or a heart."""

    @on(ItemCollected)
    def collected(self, ctx, event: ItemCollected):
        item = event.item.data
        apply_effect(ctx, item.effect, item.amount)
        if item.effect in (Effect.HEALTH, Effect.MAX_HEALTH):
            ctx.ui.flash(ctx.world.placed(Placed.keeper), color=Color.GREEN, seconds=0.25)
        if item.relic:
            ctx.get(Run).relics.append(event.item)
            ctx.ui.announce(item.name, item.blurb, seconds=1.6)
            ctx.audio.play(ctx.config(Sounds).relic)
        elif item.effect is Effect.COINS:
            ctx.audio.play(ctx.config(Sounds).coin, volume=0.6)
        else:
            ctx.ui.toast(item.name)
            ctx.audio.play(ctx.config(Sounds).pickup)

    @on(Damaged, where=lambda event: event.entity.has(Foe) and event.entity.alive)
    def foe_hit(self, ctx, event: Damaged):
        """Sell every shard that lands: a white flash and the damage number."""
        ctx.ui.flash(event.entity, color=Color.WHITE, seconds=0.08)
        ctx.ui.float_text(str(round(event.amount)), event.entity.transform.position)

    @on(Died, where=lambda event: event.entity.has(Breakable))
    def broke(self, ctx, event: Died):
        at = event.entity.transform.position
        ctx.vfx.play(Assets.vfx.break_smoke, at=at)
        drop_loot(ctx, ctx.config(Rules).breakable_loot, at)

    @on(Died, where=lambda event: event.entity.has(Foe))
    def foe_died(self, ctx, event: Died):
        foe = event.entity.get(Foe)
        at = event.entity.transform.position
        ctx.vfx.play(Assets.vfx.smoke, at=at.with_y(0.9))
        ctx.audio.play(ctx.config(Sounds).enemy_die, at=at)
        if foe.elite:
            drop_loot(ctx, ctx.config(Rules).elite_loot, at)
        if foe.kind.data.boss:
            ctx.camera.main.shake(0.5, 0.42)
            for add in ctx.world.query(Foe).where(lambda _, add: add.master == event.entity).entities():
                add.destroy()
            ctx.emit(BossSlain())

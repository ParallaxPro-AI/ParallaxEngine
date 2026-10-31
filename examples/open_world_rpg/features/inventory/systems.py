"""Pickups and potions. Buying and equipping are the shop's and gear screen's button functions."""

from parallax import System, TriggerEntered, on, system
from parallax.combat import Health
from project import Content, Text

from features.hero.feature import Hero, Mana, XpGained
from features.inventory.actions import InventoryControls
from features.inventory.bag import give, take
from features.inventory.components import Pickup
from features.inventory.config import Economy
from features.inventory.resources import Purse
from game.audio import Sounds, play
from game.feed import announce


@system("pickups")
class Pickups(System):
    """Walking into gold, a potion or a wayfarer's cache collects it."""

    @on(TriggerEntered, where=lambda event: event.entity.has(Pickup) and event.target.has(Hero))
    def collect(self, ctx, event: TriggerEntered):
        pickup = event.entity.get(Pickup)
        ctx.get(Purse).gold += pickup.gold
        for item in pickup.items:
            give(ctx, item)
        if pickup.xp:
            ctx.emit(XpGained(amount=pickup.xp))
        event.entity.destroy()


@system("potions")
class Potions(System):
    """F drinks a mana potion when the well runs low and one is in the bag, otherwise a health potion."""

    def update(self, ctx, dt):
        if not ctx.input.pressed(InventoryControls.potion):
            return
        _, health, mana = ctx.world.query(Health, Mana, tagged=Hero).single()
        if health.dead:
            return
        thirsty = mana.max - mana.current > ctx.config(Economy).mana_potion_below
        if thirsty and take(ctx, Content.item.mana_potion):
            mana.current = min(mana.max, mana.current + Content.item.mana_potion.data.mana)
            announce(ctx, ctx.text(Text.drank_mana_potion))
        elif take(ctx, Content.item.health_potion):
            health.heal(Content.item.health_potion.data.heal)
            announce(ctx, ctx.text(Text.drank_health_potion))
        else:
            return
        play(ctx, ctx.config(Sounds).potion)

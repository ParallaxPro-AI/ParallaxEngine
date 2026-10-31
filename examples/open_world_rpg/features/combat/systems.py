"""The hero's loadout, what kills pay, and combat feedback."""

import random

from parallax import Color, ContentRef, FloatStyle, System, Vec3, on, system
from parallax.combat import Damaged, Died, Health
from project import Text

from features.combat.components import Bounty, Offense
from features.combat.events import WeaknessFound
from features.combat.resources import CombatHints, HeroHurt, RunStats
from features.combat.stats import hero_stats
from features.combat.tags import Hostile
from features.hero.feature import Hero, Mana, XpGained
from features.inventory.feature import Economy, Gear, GearDef, Purse, grant_gear, scatter_loot
from game.feed import announce, hint

# The template's popups: Inter heavy over a hard ink outline, one pale colour for every kind, 20 px, a quick
# scale-up, rising 46 px over a second (its floating_text fork and the old engine's defaults).
POPUP = FloatStyle(size=20, font="Inter", color=Color.hex("#e8edf4"), outline=Color.hex("#0b1214"), outline_width=2,
                   pop=0.4, rise=46, seconds=1)


@system("loadout")
class Loadout(System):
    """Derives the hero's sword, flat armour and maximums from level, worn gear and upgrades, every frame.

    Raising a maximum raises the current value by the gain; lowering it only clamps. Armour is the combat
    plugin's `Health.flat_armor`, so every blow — sword, spell, trap or area — is reduced by it, and still
    lands for at least `combat(min_damage=1)` (game/main.py).
    """

    def update(self, ctx, dt):
        _, health, mana, offense = ctx.world.query(Health, Mana, Offense, tagged=Hero).single()
        stats = hero_stats(ctx)
        offense.damage = stats.damage
        offense.attack_rate = stats.attack_rate
        offense.element = stats.element
        health.flat_armor = stats.defense
        if not health.dead:
            health.current = min(stats.max_health, health.current + max(0.0, stats.max_health - health.max))
        health.max = stats.max_health
        mana.current = min(stats.max_mana, mana.current + max(0.0, stats.max_mana - mana.max))
        mana.max = stats.max_mana


@system("bounties")
class Bounties(System):
    """Kills pay gold and experience, scatter loot and hand out gear; the hero's own fall costs a tithe."""

    @on(Died, where=lambda event: event.entity.has(Bounty))
    def pay(self, ctx, event: Died):
        bounty = event.entity.get(Bounty)
        where = event.entity.transform.position
        gold = random.randint(bounty.gold_min, bounty.gold_max)
        ctx.get(Purse).gold += gold
        ctx.emit(XpGained(amount=bounty.xp))
        ctx.ui.float_text(ctx.text(Text.gold_gain, amount=gold), where + Vec3.UP * 1.6, style=POPUP)
        ctx.ui.float_text(ctx.text(Text.xp_gain, amount=bounty.xp), where + Vec3.UP * 2.0, style=POPUP)
        if bounty.loot is not None:
            scatter_loot(ctx, bounty.loot.data, where)
        if random.random() <= bounty.gear_chance:
            self.drop_gear(ctx, bounty.gear)

    @on(Died, where=lambda event: event.entity.has(Hero))
    def tithe(self, ctx, event: Died):
        purse = ctx.get(Purse)
        toll = int(purse.gold * ctx.config(Economy).death_toll)
        if toll > 0:
            purse.gold -= toll

    def drop_gear(self, ctx, pool: list[ContentRef[GearDef]]):
        owned = ctx.get(Gear).owned
        piece = next((p for p in pool if p not in owned), None)
        if piece is None:
            return
        line = Text.gear_equipped if grant_gear(ctx, piece) else Text.gear_found
        announce(ctx, ctx.text(line, piece=ctx.text(piece.data.name)))


@system("combat_feedback")
class CombatFeedback(System):
    """Damage numbers, hit flashes, the kill count, and the 'weak!' / 'resisted' hints."""

    @on(Damaged)
    def show_hit(self, ctx, event: Damaged):
        hurt_hero = event.entity.has(Hero)
        if not hurt_hero:
            at = event.point or event.entity.transform.position + Vec3.UP * 1.6
            ctx.ui.float_text(f"-{round(event.amount)}", at, style=POPUP)
        ctx.ui.flash(event.entity, color=Color.RED if hurt_hero else Color.WHITE)
        if hurt_hero:
            ctx.get(HeroHurt).at = ctx.time.now
            ctx.camera.main.shake(0.2, 0.15)

    @on(Died)
    def count(self, ctx, event: Died):
        stats = ctx.get(RunStats)
        if event.entity.has(Hero):
            stats.streak = 0
        elif event.entity.has(Hostile):
            stats.kills += 1
            stats.streak += 1
            stats.best_streak = max(stats.best_streak, stats.streak)

    @on(WeaknessFound, where=lambda event: event.attacker.has(Hero))
    def hint(self, ctx, event: WeaknessFound):
        hints = ctx.get(CombatHints)
        key = f"{event.effect}:{event.kind.id}"
        if key == hints.last and ctx.time.now - hints.shown_at < 3:
            return
        hints.last = key
        hints.shown_at = ctx.time.now
        line = Text.hint_weak if event.effect == "weak" else Text.hint_resisted
        hint(ctx, ctx.text(line, kind=event.kind.id.capitalize(), multiplier=round(event.multiplier, 1)))

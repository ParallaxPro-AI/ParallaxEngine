"""Leveling up and getting back up."""

from parallax import Context, System, Vec3, on, system, vec3
from parallax.characters import Character
from parallax.combat import Died, Health
from project import Assets, Text

from features.hero.components import Hero, Mana
from features.hero.config import HeroCurve
from features.hero.events import HeroRespawned, LevelledUp, XpGained
from features.hero.progression import xp_to_next
from features.hero.resources import Checkpoint, Progression, Respawn
from game.audio import Sounds, play
from game.feed import Kind, announce


@system("leveling")
class Leveling(System):
    """Turns experience into levels along the curve in config/hero_curve.json."""

    @on(XpGained)
    def gain(self, ctx, event: XpGained):
        progress = ctx.get(Progression)
        curve = ctx.config(HeroCurve)
        progress.xp += event.amount
        while progress.xp >= xp_to_next(curve, progress.level):
            progress.xp -= xp_to_next(curve, progress.level)
            progress.level += 1
            ctx.emit(LevelledUp(level=progress.level))

    @on(LevelledUp)
    def celebrate(self, ctx, event: LevelledUp):
        hero, health, mana = ctx.world.query(Health, Mana, tagged=Hero).single()
        health.heal(health.max)
        mana.current = mana.max
        announce(ctx, ctx.text(Text.level_up, level=event.level), Kind.LEVEL, ctx.text(Text.level_up_detail))
        ctx.vfx.play(Assets.vfx.level_up, at=hero.transform.position + vec3(0, 1, 0))
        play(ctx, ctx.config(Sounds).level_up)


@system("respawning")
class Respawning(System):
    """A fallen hero rises at the current checkpoint shrine after a short wait — even when the shrine's
    region has streamed out, because only its authored position is needed."""

    @on(Died, where=lambda event: event.entity.has(Hero))
    def fell(self, ctx, event: Died):
        ctx.get(Respawn).countdown.restart(ctx.config(HeroCurve).respawn_seconds)
        play(ctx, ctx.config(Sounds).hero_falls)

    def update(self, ctx, dt):
        if ctx.get(Respawn).countdown.tick(dt):
            self.rise(ctx)

    def rise(self, ctx):
        hero, health, mana, body = ctx.world.query(Health, Mana, Character, tagged=Hero).single()
        body.teleport(rise_point(ctx))
        health.revive()
        mana.current = mana.max
        ctx.emit(HeroRespawned(hero=hero))


def rise_point(ctx: Context) -> Vec3:
    """Where a fallen hero gets up: the current checkpoint, as the template stores it."""
    return ctx.world.placement(ctx.get(Checkpoint).shrine).position

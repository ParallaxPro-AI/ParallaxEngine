"""Applying an Effect bag to the survivor: the one function both the draft deck and the
shrine use."""

from parallax import Context
from parallax.characters import Character
from parallax.combat import Health

from game.components import Build
from game.content import Effect
from game.resources import Draft
from game.rules import Rules, survivor


def apply_effect(ctx: Context, effect: Effect) -> None:
    """Permanent for the run, so it changes base values (the prefab's) rather than
    stacking keyed modifiers."""
    rules = ctx.config(Rules)
    hero = survivor(ctx)
    build = hero.get(Build)
    build.damage += effect.damage_add
    build.fire_interval = max(rules.min_fire_interval, build.fire_interval * effect.fire_interval_mul)
    build.bolts += effect.bolts_add
    build.pierce += effect.pierce_add
    build.hit_radius += effect.hit_radius_add
    hero.get(Character).walk_speed *= effect.speed_mul
    build.pickup_radius += effect.pickup_add
    build.nova_cooldown = max(rules.min_nova_cooldown, build.nova_cooldown * effect.nova_cooldown_mul)
    build.nova_radius += effect.nova_radius_add
    build.nova_damage += effect.nova_damage_add
    build.xp_mul *= effect.xp_mul
    build.aura_dps += effect.aura_dps_add
    build.aura_radius += effect.aura_radius_add
    build.lifesteal += effect.lifesteal_add
    build.revives += effect.revive_add
    ctx.get(Draft).rerolls += effect.reroll_add

    health = hero.get(Health)
    health.max += effect.max_health_add
    health.invulnerable_after_hit += effect.mercy_add
    health.heal(effect.max_health_add + health.max * effect.heal_pct)

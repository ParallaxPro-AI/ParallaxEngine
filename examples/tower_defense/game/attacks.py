"""What a tower's shot does when it lands.

SINGLE  one hit
SPLASH  full damage to the target, half to everything else in the blast
CHAIN   one hit that arcs to the nearest unhit enemies, weaker each hop

Then, if the tower's level carries a status effect (ice chills, venom poisons),
everything it struck gets a dose of it, less whatever that enemy resists. Both
effects keep only the strongest dose (`"stacking": "strongest"`).
"""

import math

from parallax import Color, Context, Entity, Vec3
from parallax.combat import Health, StatusEffects

from game.components import Invader, Shot
from game.content import Attack, TowerLevel
from game.siege import stats

LIGHTNING = Color.hex("#c4b5fd")
"""Colour of a chain-lightning arc."""


def land(ctx: Context, shot: Shot, point: Vec3) -> None:
    tower = shot.tower.data
    level = stats(shot.tower, shot.level)
    target = shot.target if shot.target.alive else None
    ctx.vfx.play(tower.impact, at=point)
    if tower.attack is Attack.SPLASH:
        struck = splash(ctx, level, point, target)
    elif target is None:
        return
    elif tower.attack is Attack.CHAIN:
        struck = chain(ctx, level, target)
    else:
        target.get(Health).damage(level.damage)
        struck = [target]
    if level.effect is not None:
        for enemy in struck:
            if enemy.alive:
                afflict(enemy, level)


def afflict(enemy: Entity, level: TowerLevel) -> None:
    resisted = enemy.get(Invader).kind.data.resists.get(level.effect, 0)
    if resisted < 1:
        enemy.get(StatusEffects).apply(level.effect, level.effect_seconds, strength=level.effect_strength * (1 - resisted))


def splash(ctx: Context, level: TowerLevel, point: Vec3, target: Entity | None) -> list[Entity]:
    struck = ctx.world.query(Invader).near(point, level.splash_radius).entities()
    for enemy in struck:
        enemy.get(Health).damage(level.damage if enemy == target else math.floor(level.damage / 2))
    return struck


def chain(ctx: Context, level: TowerLevel, first: Entity) -> list[Entity]:
    struck = [first]
    first.get(Health).damage(level.damage)
    for hop in range(1, level.chain_count):
        here = struck[-1].transform.position
        rows = ctx.world.query(Invader).near(here, level.chain_range).by_distance(here)
        enemy = next((enemy for enemy, _ in rows if enemy not in struck), None)
        if enemy is None:
            break
        enemy.get(Health).damage(math.floor(level.damage * level.chain_falloff ** hop))
        ctx.vfx.beam(here, enemy.transform.position, color=LIGHTNING, width=0.12)
        struck.append(enemy)
    return struck

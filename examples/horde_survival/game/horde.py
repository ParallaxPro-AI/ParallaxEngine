"""Spawning the horde: one enemy, or a coherent clump of them, under the horde ceiling."""

import random

from parallax import Context, ContentRef, Entity, Vec3, scatter, vec3
from parallax.combat import Health

from game.components import Foe, Horde
from game.content import EnemyDef, SurgeDef
from game.rules import Rules


def spawn_foe(ctx: Context, enemy: ContentRef[EnemyDef], at: Vec3, hp_scale: float, speed_scale: float) -> Entity | None:
    if ctx.world.query(tagged=Horde).count() >= ctx.config(Rules).max_enemies:
        return None
    data = enemy.data
    hp = data.hp * hp_scale
    return ctx.world.spawn(data.prefab, at=at, rotation=vec3(0, random.uniform(0, 360), 0), components=[
        Health(current=hp, max=hp),
        Foe(kind=enemy, damage=data.damage, speed=data.move_speed * speed_scale),
    ])


def spawn_cluster(ctx: Context, enemy: ContentRef[EnemyDef], count: int, center: Vec3,
                  hp_scale: float, speed_scale: float) -> None:
    """A surge arrives as a clump with real spacing, not a shotgun spray."""
    rules = ctx.config(Rules)
    for spot in scatter(center, rules.cluster_radius, count, min_spacing=rules.cluster_spacing):
        spawn_foe(ctx, enemy, spot, hp_scale, speed_scale)


def current_surge(ctx: Context) -> SurgeDef:
    """The last time tier whose start has passed: a horde never stops, it gets worse."""
    return [surge.data for surge in ctx.content(SurgeDef) if surge.data.at_second <= ctx.time.scene_time][-1]

"""The Ember Nova's shockwave, shared by the nova button and a Second Wind rekindle."""

from parallax import Context, Entity, vec3
from project import Assets

from game.components import CinderShard
from game.rules import Rules


def blast(ctx: Context, source: Entity, radius: float, damage: float) -> None:
    """Burn everything in reach, throw the survivors back, and sweep shards out of the air."""
    at = source.transform.position
    knockback = ctx.config(Rules).nova_knockback
    for foe in ctx.combat.area_damage(at, radius, damage, source=source, falloff=False):
        foe.transform.position += (foe.transform.position - at).flat().normalized() * knockback
    for shard in ctx.world.query(tagged=CinderShard).near(at, radius).entities():
        shard.destroy()
    ctx.vfx.play(Assets.vfx.nova_fire, at=at + vec3(0, 0.3, 0))
    ctx.vfx.play(Assets.vfx.nova_sparks, at=at + vec3(0, 0.2, 0))

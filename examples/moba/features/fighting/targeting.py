from parallax import Context, Entity, Vec3
from parallax.combat import Health


def can_fight(ctx: Context, me: Entity, other: Entity | None) -> bool:
    """`other` is alive, enemy to `me` and still attackable."""
    return bool(other and other.alive and ctx.combat.are_enemies(me, other) and not other.get(Health).dead)


def enemies_near(ctx: Context, me: Entity, point: Vec3, radius: float) -> list[Entity]:
    return ctx.world.query(Health).near(point, radius).where(lambda e, _: can_fight(ctx, me, e)).entities()


def nearest_enemy(ctx: Context, me: Entity, radius: float) -> Entity | None:
    here = me.transform.position
    return min(enemies_near(ctx, me, here, radius), key=lambda e: (e.transform.position - here).length(), default=None)


def distance(a: Entity, b: Entity) -> float:
    return (a.transform.position - b.transform.position).flat().length()

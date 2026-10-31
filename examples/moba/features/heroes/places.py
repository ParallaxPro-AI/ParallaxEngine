from parallax import Context, Entity

from features.heroes.components import Fountain


def fountain_of(ctx: Context, unit: Entity) -> Entity:
    """The fountain of `unit`'s team."""
    return ctx.world.query(Fountain).where(lambda fountain, _: not ctx.combat.are_enemies(fountain, unit)).entities()[0]

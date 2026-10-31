"""The player's car, and finding one to get into."""

from parallax import Context, Entity
from parallax.characters import Character
from parallax.vehicles import Vehicle

from features.driving.components import CarCondition
from features.driving.config import DrivingRules
from features.on_foot.feature import Player


def player_car(ctx: Context) -> Entity | None:
    """The car the player is sitting in, if any (None on a scene without the player, such as
    the title: input conditions are asked there too)."""
    row = ctx.world.query(Character, tagged=Player).first()
    return row[1].vehicle if row is not None else None


def nearest_free_car(ctx: Context, person: Entity) -> Entity | None:
    """The closest car within reach that nobody is driving and that is not wrecked."""
    here = person.transform.position
    row = (
        ctx.world.query(Vehicle, CarCondition)
        .near(here, ctx.config(DrivingRules).enter_distance)
        .where(lambda car, vehicle, condition: vehicle.driver is None and condition.damage < 1)
        .nearest(here)
    )
    return row[0] if row is not None else None

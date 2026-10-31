"""The wanted meter."""

import math
from enum import Enum

from parallax import Context, Vec3, field, resource


class Phase(Enum):
    """calm: nobody is after the player. chase: a unit sees them. search: they have been out of sight a
    while and units hunt the last sighting."""

    CALM = "calm"
    CHASE = "chase"
    SEARCH = "search"


@resource("wanted")
class Wanted:
    """Heat (fractional stars), the pursuit's phase and where the player was last seen."""

    heat: float = field(0, min=0)
    phase: Phase = field(Phase.CALM)
    last_seen: Vec3 = field(Vec3.ZERO)
    unseen_for: float = field(0, min=0, unit="s")


def wanted_level(wanted: Wanted) -> int:
    """Stars shown: any heat at all is at least one star."""
    return math.ceil(wanted.heat)


def pursuing(ctx: Context) -> bool:
    """A pursuit is on (chase or search)."""
    return ctx.get(Wanted).phase is not Phase.CALM

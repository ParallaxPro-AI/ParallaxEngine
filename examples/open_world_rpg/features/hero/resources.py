"""Game-wide state about the hero."""

from parallax import EntityRef, Timer, field, resource
from project import Placed


@resource("progression", keep="profile")
class Progression:
    """Level and experience. Profile tier: the realm remembers its hero across new games."""

    level: int = field(1, min=1)
    xp: int = field(0, min=0, doc="Experience gathered towards the next level.")


@resource("checkpoint")
class Checkpoint:
    """The shrine a fallen hero rises at. Chapters move it forward as the story advances."""

    shrine: EntityRef = field(Placed.village_shrine)


@resource("respawn")
class Respawn:
    """Counts down while the hero is down; done while the hero is standing."""

    countdown: Timer = field(Timer.cooldown(3))

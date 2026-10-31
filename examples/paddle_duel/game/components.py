"""Tags and per-entity data."""

from parallax import component, field, tag

Ball = tag("ball")
Paddle = tag("paddle")
Wall = tag("wall")
PlayerGoal = tag("player_goal")
RivalGoal = tag("rival_goal")
RivalTint = tag("rival_tint")  # drawn in the current rival's colour


@component("smash")
class Smash:
    """A paddle that can load a smash. The player's paddle builds `charge` while the
    smash button is held; the ball spends it on the next return."""
    charge: float = field(0.0, min=0, max=1)
    threshold: float = field(0.2, min=0, max=1, doc="Smallest charge that counts as a smash.")
    boost: float = field(0.55, min=0, doc="Extra return speed at full charge (fraction).")

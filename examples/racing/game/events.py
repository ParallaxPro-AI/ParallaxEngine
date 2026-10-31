"""Events. Garage choices are plain panel actions (game/garage.py); the one beat other
logic reacts to is the end of a race."""

from parallax import event


@event("race_finished")
class RaceFinished:
    """The player crossed the line; the race is scored now."""

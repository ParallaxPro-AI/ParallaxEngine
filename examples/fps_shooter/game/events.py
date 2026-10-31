"""Events."""

from parallax import Entity, event


@event("shot_fired", target="shooter")
class ShotFired:
    shooter: Entity
    hit: Entity | None


@event("frag_scored")
class FragScored:
    """Someone on the scoreboard killed someone else."""

    killer: str
    victim: str
    streak: int

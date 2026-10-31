"""Combat messages."""

from typing import Literal

from parallax import Entity, Tag, event


@event("staggered", target="entity")
class Staggered:
    """A blow knocked the entity off balance; long enough staggers cancel a windup."""

    entity: Entity
    seconds: float


@event("weakness_found")
class WeaknessFound:
    """A blow hit harder or softer than usual because of the target's affinity."""

    attacker: Entity
    kind: Tag
    effect: Literal["weak", "resisted"]
    multiplier: float

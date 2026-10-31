"""Events the escape emits.

Menu buttons are panel commands or plain functions (see `game/ui.py` and
`systems/lockup.py`), so none of them needs an event."""

from parallax import ContentRef, Entity, Vec3, event

from game.content import DistrictDef, ObstacleDef, PowerUpDef


@event("district_entered")
class DistrictEntered:
    district: ContentRef[DistrictDef]


@event("coin_taken")
class CoinTaken:
    at: Vec3


@event("near_missed")
class NearMissed:
    at: Vec3


@event("obstacle_hit")
class ObstacleHit:
    kind: ContentRef[ObstacleDef]
    at: Vec3


@event("obstacle_smashed")
class ObstacleSmashed:
    at: Vec3


@event("powerup_taken")
class PowerUpTaken:
    kind: ContentRef[PowerUpDef]
    at: Vec3


@event("stumbled", target="entity")
class Stumbled:
    entity: Entity


@event("coins_earned")
class CoinsEarned:
    amount: int


@event("run_ended")
class RunEnded:
    won: bool

"""Per-entity data and tags."""

from parallax import ContentRef, component, field, tag

from game.content import ObstacleDef, PowerUpDef

Coin = tag("coin")
Streamed = tag("streamed")


@component("runner")
class Runner:
    """What the rest of the game needs to know about the runner: which lane,
    how fast, and whether it's sliding (that's what clears an overhead bar)."""

    lane: int = field(1, min=0)
    speed: float = field(0, unit="m/s")
    sliding: bool = field(False)


@component("obstacle")
class Obstacle:
    kind: ContentRef[ObstacleDef] = field()
    brushed: bool = field(False, doc="Passed close alongside: a near miss once it's behind you.")


@component("powerup")
class PowerUp:
    kind: ContentRef[PowerUpDef] = field()

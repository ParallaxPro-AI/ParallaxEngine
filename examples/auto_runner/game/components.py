"""Per-entity data and tags."""

from parallax import ContentRef, component, field, tag

from game.content import ObstacleDef

Runner = tag("runner")
Coin = tag("coin")
GroundTint = tag("ground_tint")


@component("hopper")
class Hopper:
    """The runner's hop physics. Shared on purpose: the runner behavior flies it,
    and the hazard feeder and coin layouts size everything against the airtime
    it implies (2 * hop_speed / gravity)."""

    gravity: float = field(62, unit="m/s²")
    hop_speed: float = field(18, unit="m/s")
    max_fall: float = field(42, unit="m/s")
    fast_fall_scale: float = field(2.6, min=1, doc="Gravity multiplier while duck is held in the air.")
    jump_buffer: float = field(0.12, unit="s", doc="A hop pressed this long before landing still counts.")
    height: float = field(1.1, unit="m")
    duck_height: float = field(0.62, unit="m")
    hitbox_scale: float = field(0.84, min=0.1, max=1, doc="Hitbox as a fraction of the body: a forgiving inset.")


@component("scrolls")
class Scrolls:
    """Moves left with the world. `factor` < 1 is parallax depth."""

    factor: float = field(1, min=0)
    wrap_span: float = field(0, unit="m", doc="0 = despawn off the left edge; else wrap by this width.")


@component("obstacle")
class Obstacle:
    kind: ContentRef[ObstacleDef] = field()
    passed: bool = field(False)

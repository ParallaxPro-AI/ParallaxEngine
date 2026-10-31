from parallax import field, resource


@resource("tally")
class Tally:
    value: int = field(0)
    held_frames: int = field(0)
    releases: int = field(0)
    steered: float = field(0.0)
    throttle: float = field(0.0)
    lane: int = field(-1)
    roll: int = field(0)
    tap_x: float = field(-1.0)
    tap_world_x: float = field(-100.0)
    typed: str = field("")
    explode: bool = field(False)

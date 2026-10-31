from enum import Enum

from parallax import Vec2, Vec3, component, field


class Phase(Enum):
    AIMING = "aiming"
    CHARGING = "charging"
    FLYING = "flying"
    STUCK = "stuck"


@component("throw")
class Throw:
    """The dart's throw in progress. Written by the dart's `dart_throw` behavior;
    read by the camera, the aim line and the HUD."""
    phase: Phase = field(Phase.AIMING)
    aim: Vec2 = field(Vec2.ZERO, unit="m", doc="Reticle offset from the bull on the board face.")
    power: float = field(0.0, min=0, max=1)
    path: list[Vec3] = field([], doc="Predicted flight while aiming; empty otherwise.")

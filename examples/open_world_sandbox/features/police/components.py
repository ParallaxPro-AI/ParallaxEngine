"""Per-unit police data."""

from parallax import component, field


@component("spotter")
class Spotter:
    """How far this unit sees the player. Helicopters see from above without line of sight."""

    range: float = field(32, min=0, unit="m")
    fov: float = field(140, min=1, max=360, unit="deg")
    needs_line_of_sight: bool = field(True)

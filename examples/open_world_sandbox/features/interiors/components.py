"""Interior volumes."""

from parallax import TextRef, Vec3, component, field


@component("interior_zone")
class InteriorZone:
    """An axis-aligned box inside a building shell. Standing in it means being indoors."""

    name: TextRef = field()
    size: Vec3 = field(Vec3(10, 4, 10), unit="m")
    camera_distance: float = field(2.6, min=0.5, unit="m", doc="How close the camera pulls in here.")

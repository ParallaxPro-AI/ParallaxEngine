"""Phone state."""

from parallax import ContentRef, ImageRef, field, resource

from features.phone.content import PlaceDef


@resource("photo_mode", keep="scene")
class PhotoMode:
    """True while looking through the phone's camera."""

    active: bool = field(False)
    zoom: float = field(1, min=1, max=4)


@resource("gallery")
class Gallery:
    photos: list[ImageRef] = field([])


@resource("waypoint", keep="scene")
class Waypoint:
    """The place routed from the phone's map. Jobs mark their own stops through their quest steps."""

    target: ContentRef[PlaceDef] | None = field(None)

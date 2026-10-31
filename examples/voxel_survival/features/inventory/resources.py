from parallax import Entity, field, resource


@resource("open_station")
class OpenStation:
    """The chest or furnace the player is using. Using one sets it; the chest and
    furnace panels open while it is set, and their Close button clears it."""
    station: Entity | None = field(None, keep="scene")

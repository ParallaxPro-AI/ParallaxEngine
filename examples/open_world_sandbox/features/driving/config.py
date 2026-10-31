"""Getting in and out of cars (config/driving_rules.json)."""

from parallax import MusicRef, config, field


@config("driving_rules")
class DrivingRules:
    """Read by the driver behavior and by the HUD's "E — Steal car" prompt, so both agree on the reach."""

    enter_distance: float = field(4, unit="m")
    exit_speed: float = field(3, unit="m/s", doc="You can only step out below this speed.")
    radio: MusicRef = field(doc="The station that plays while the player drives (the template's vehicle music).")
    street: MusicRef = field(doc="The street music that comes back on foot (the scene's own track).")

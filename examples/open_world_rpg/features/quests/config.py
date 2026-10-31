"""The Shadow Rift's countdown (config/shadow_rift.json)."""

from parallax import config, field


@config("shadow_rift")
class ShadowRift:
    """The countdown on the last chapter: reaching zero ends the run."""

    duration: float = field(360, min=1, unit="s")
    death_penalty: float = field(25, min=0, unit="s", doc="Taken off the clock each time the hero falls.")
    critical_at: float = field(60, unit="s", doc="Below this the HUD turns the countdown red.")
    weather: str = field("overcast", doc="The weather preset the sky blends to when the rift opens.")
    weather_blend: float = field(8, min=0, unit="s")
    storm_at: float = field(60, min=0, unit="s", doc="Seconds remaining when the storm rolls in over the finale.")
    storm: str = field("storm", doc="The weather preset of the finale.")

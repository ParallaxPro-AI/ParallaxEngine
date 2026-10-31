"""How a pursuit runs (config/pursuit.json)."""

from parallax import EntityRef, config, field


@config("pursuit")
class Pursuit:
    max_heat: float = field(5, min=1)
    search_after: float = field(6, unit="s", doc="Unseen this long and the police start searching.")
    lose_after: float = field(22, unit="s", doc="Unseen this long and they give up.")
    arrest_fine: float = field(0.25, min=0, max=1)
    busted_seconds: float = field(2.5, unit="s")
    release: EntityRef = field(doc="Where the police let you go.")
    dispatch_interval: float = field(1, unit="s")
    spawn_min: float = field(60, unit="m")
    spawn_max: float = field(95, unit="m")
    stand_down: float = field(160, unit="m", doc="Units further than this are recalled once calm.")
    helicopter_altitude: float = field(35, unit="m")
    roadblock_ahead: float = field(90, unit="m")

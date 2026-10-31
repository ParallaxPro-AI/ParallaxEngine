"""Game-wide tunables: config/rules.json, read with `ctx.config(Rules)`."""

from parallax import config, field


@config("rules")
class Rules:
    wake_hour: float = field(min=0, max=24, doc="Sleeping skips to this hour.")
    station_range: float = field(unit="m", doc="How near a workbench or furnace must be to use it.")
    build_min_y: int = field()
    build_max_y: int = field()
    void_y: float = field(unit="m", doc="Falling below this brings the player home.")
    autosave_every: float = field(unit="s")
    lives: int = field(min=1, doc="Deaths allowed in a challenge run.")
    hunger_warning: float = field(doc="The HUD turns amber below this.")
    sleep_heal: float = field()
    sleep_hunger: float = field(doc="Hunger a night's sleep costs.")
    sleep_threat_radius: float = field(unit="m")
    spawn_radius: float = field(unit="m", doc="Hostiles appear this far from the player.")
    beacon_safe_radius: float = field(unit="m")
    wave_max_alive: list[int] = field(doc="Hostile cap by wave; the last entry repeats.")
    wave_interval: list[float] = field(doc="Seconds between spawns by wave; the last entry repeats.")
    siege_seconds: float = field(unit="s")
    siege_radius: float = field(unit="m")
    siege_max_alive: int = field()
    siege_interval: float = field(unit="s")
    siege_weather: str = field(doc="The weather preset the beacon siege brings.")
    herd_size: int = field()
    herd_radius: float = field(unit="m")
    herd_interval: float = field(unit="s")
    herd_leash: float = field(unit="m")
    herd_regrow: float = field(unit="s")

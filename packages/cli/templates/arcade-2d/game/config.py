from parallax import config, field


@config("rules")
class Rules:
    """Tunables for the whole game, read with `ctx.config(Rules)`; the values are in
    `config/rules.json`. Game code can't change config at run time."""
    spawn_every: float = field(min=0.05, unit="s", doc="Seconds between new rocks.")
    fall_speed: float = field(min=0, unit="m/s")
    spawn_height: float = field(unit="m", doc="Where rocks appear (just above the top of the screen).")
    floor: float = field(unit="m", doc="Rocks below this height are gone for good.")
    spread: float = field(min=0, unit="m", doc="Rocks appear anywhere from -spread to +spread on x.")

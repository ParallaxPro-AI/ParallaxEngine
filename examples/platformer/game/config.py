"""Rules shared by every level: one typed document, `config/rules.json`."""

from parallax import Localized, config, field


@config("rules")
class Rules:
    """Lives, deaths, stomps, checkpoints, the chain and the finish bonuses."""

    start_lives: int
    max_lives: int
    kill_plane: float = field(unit="m")
    stomp_height: float = field(unit="m", doc="Feet this far above an enemy's origin, falling, is a stomp.")
    stomp_bounce: float = field(unit="m/s")
    respawn_grace: float = field(unit="s")
    respawn_lift: float = field(unit="m", doc="Respawn this far above the checkpoint, so you drop onto it.")
    death_pause: float = field(unit="s")
    crumble_respawn: float = field(unit="s")
    checkpoint_min_gap: float = field(unit="m", doc="Autosave only after this much forward progress.")
    checkpoint_clearance: float = field(unit="m", doc="No autosave this close to a hazard.")
    chain_window: float = field(unit="s")
    chain_step: float
    chain_max: float
    goal_bonus: int
    lives_bonus: int
    time_bonus_per_second: int
    vault_bridge_rise: float = field(unit="m", doc="How far the Lantern Vault bridge rises once every plate is lit.")
    vault_bridge_speed: float = field(unit="m/s")
    tip_spacing: float = field(unit="m")
    tips: list[Localized] = field(doc="Shown in order as you get further into a level.")

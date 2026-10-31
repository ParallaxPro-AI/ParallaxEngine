"""Game-wide tunables, one document per concern: the Wisp's limits (config/build.json),
the playfield (config/arena.json) and scoring (config/points.json). The stock Wisp
itself is its prefab."""

from parallax import config, field


@config("build")
class Build:
    """The limits every attunement and bloom works within."""
    shrine_offers: int = field(3, min=1)
    shield_cap: int = field(3, min=0)
    spirit_max: float = field(25, doc="Spirit that converts into one bomb.")
    bomb_damage: float = field(4)
    bomb_invulnerability: float = field(1.4, unit="s")


@config("arena")
class Arena:
    """The playfield: contact radii, edges and the wave spawner's rhythm."""
    hit_radius: float = field(0.18, unit="m", doc="The Wisp's pinpoint hitbox.")
    graze_radius: float = field(0.72, unit="m")
    touch_radius: float = field(0.6, unit="m", doc="Guardian body contact, before scale.")
    spark_radius: float = field(0.55, unit="m", doc="Spark contact, before scale.")
    standard_scale: float = field(0.95, unit="m", doc="Bigger guardians reach further by half the difference.")
    field_half_width: float = field(4.5, unit="m")
    field_top: float = field(8.5, unit="m", doc="Guardians enter here.")
    escape_line: float = field(-9.0, unit="m", doc="A guardian below this escapes and hurts the Wisp.")
    cull_half_width: float = field(6.0, unit="m", doc="Sparks and petals past this are cleared.")
    cull_half_height: float = field(9.5, unit="m")
    spawn_first: float = field(0.35, unit="s")
    spawn_gap: float = field(0.45, unit="s")


@config("points")
class Points:
    """Score values and the kill chain."""
    chain_window: float = field(2.6, unit="s")
    chain_gain: float = field(0.2, doc="Multiplier steps per kill in a chain.")
    max_multiplier: int = field(6)
    wave_bonus: int = field(250, doc="Times the number of waves cleared.")
    graze_score: int = field(10)
    bloom_score: int = field(50)
    win_bonus_per_life: int = field(500)
    win_bonus_per_shield: int = field(150)
    win_bonus_per_bomb: int = field(200)

"""The hero's base stats and growth curve (config/hero_curve.json)."""

from parallax import config, field


@config("hero_curve")
class HeroCurve:
    """Stats at level 1, what each level adds, and how much experience each level costs."""

    base_health: float = field(200, min=1)
    base_mana: float = field(100, min=0)
    base_damage: float = field(28, min=0)
    base_attack_rate: float = field(1.6, min=0.2, unit="swings/s")
    health_per_level: float = field(20, min=0)
    mana_per_level: float = field(10, min=0)
    first_level_xp: int = field(100, min=1)
    xp_growth: float = field(1.5, min=1, doc="Each level costs this many times the one before.")
    respawn_seconds: float = field(3, min=0, unit="s")

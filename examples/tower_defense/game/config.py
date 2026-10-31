"""The economy and pacing rules shared by every battlefield (config/siege.json)."""

from parallax import config, field


@config("siege")
class SiegeRules:
    interest_rate: float = field(doc="Paid on banked gold when a wave is cleared.")
    interest_cap: int
    clear_bonus: int
    clear_bonus_per_wave: int
    boss_bonus_mul: float
    no_leak_bonus: int
    sell_refund: float = field(min=0, max=1)
    first_spawn_delay: float = field(unit="s")
    spawn_gap: float = field(unit="s")
    spawn_gap_per_wave: float = field(unit="s", doc="Added per wave (negative tightens the horde).")
    min_spawn_gap: float = field(unit="s")
    pad_pick_radius: float = field(unit="m")
    score_per_gold: int
    score_per_life: int
    score_per_wave: int
    two_star_lives: float = field(min=0, max=1, doc="Fraction of lives kept for two stars (all = three).")

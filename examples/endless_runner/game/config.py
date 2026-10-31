"""The escape's tunables: one typed document, `config/rules.json`."""

from parallax import config, field


@config("rules")
class Rules:
    """Numbers the street, the collisions, the economy and the chase share."""

    lane_xs: list[float] = field(doc="Lane centres, left to right.")
    countdown: int
    segment_length: float = field(unit="m")
    spawn_ahead: float = field(unit="m")
    despawn_behind: float = field(unit="m")
    building_spacing: float = field(unit="m")
    building_offset: float = field(unit="m")
    gap_min: float = field(unit="m")
    gap_max: float = field(unit="m")
    gap_floor: float = field(unit="m")
    gap_margin: float = field(unit="m", doc="Added to the decision-time floor.")
    decision_seconds: float = field(unit="s", doc="Gaps never shrink below this much travel time.")
    coin_spacing: float = field(unit="m")
    coin_height: float = field(unit="m")
    low_coin_height: float = field(unit="m", doc="Coins under an overhead bar: slide for them.")
    arc_height: float = field(unit="m")
    powerup_chance: float = field(min=0, max=1)
    powerup_chance_floor: float = field(min=0, max=1)
    powerup_bias_damping: float = field(doc="How much the hard bias thins power-up drops.")
    collect_radius: float = field(unit="m")
    body_width: float = field(unit="m")
    body_depth: float = field(unit="m")
    near_miss_radius: float = field(unit="m")
    hit_cooldown: float = field(unit="s")
    coin_score: int
    style_score: int
    combo_step: int = field(doc="Coins or near-misses per combo level.")
    combo_max: int
    magnet_radius: float = field(unit="m")
    magnet_pull: float = field(unit="m/s")
    escape_bonus: int
    mission_distance: float = field(unit="m")
    mission_combo: int
    mission_reward: int
    guard_follow: float = field(unit="m", doc="Starting gap: the run's health bar.")
    guard_catch_up: float = field(unit="m", doc="Gap lost per hit.")
    guard_recover: float = field(unit="m/s")
    guard_catch: float = field(unit="m")
    ramp_start: float = field(unit="m")
    gap_shrink_per_100m: float
    gap_shrink_max: float
    hard_bias_per_100m: float
    endless_bias_per_1000m: float
    district_fog_blend: float = field(unit="s")
    end_card_delay: float = field(unit="s")

"""The run's tunables: one typed document, `config/canyon.json`."""

from parallax import SoundRef, config, field


@config("canyon")
class Canyon:
    """Numbers the course, the hazard feed, the coins and the end beat share.
    Hearts and the blink after a hit live on the runner's `Health` instead."""

    runner_x: float = field(unit="m")
    ground_y: float = field(unit="m")
    spawn_x: float = field(unit="m")
    despawn_x: float = field(unit="m")
    base_speed: float = field(unit="m/s")
    endless_speed_cap: float = field(unit="m/s")
    endless_ramp_per_100m: float = field(unit="m/s")
    min_react_time: float = field(unit="s", doc="Added to one hop's airtime: the shortest legal gap.")
    floor_distance: float = field(unit="m")
    seed_hazards: int = field(min=0)
    pass_margin: float = field(unit="m")
    praise_seconds: float = field(unit="s", doc="How long a 'Clean hop!' stays in the HUD.")
    coin_value: int = field(min=1)
    streak_step: int = field(min=1, doc="Clean coins per multiplier step.")
    max_multiplier: int = field(min=1)
    arc_count: int = field(min=2)
    arc_span: float = field(min=0, max=1, doc="Fraction of the hop the coin arc covers.")
    line_count: int
    line_spacing: float = field(unit="m")
    line_y: float = field(unit="m")
    duck_line_count: int
    duck_line_spacing: float = field(unit="m")
    duck_line_y: float = field(unit="m")
    goal_distance: float = field(unit="m")
    gate_lead: float = field(unit="m")
    gate_y: float = field(unit="m")
    run_in: float = field(unit="m", doc="Hazard-free stretch before the finish gate.")
    hit_shake: float
    end_card_delay: float = field(unit="s")


@config("sounds")
class Sounds:
    """The run's sounds: the template's own files, served from the ParallaxPro asset
    store. Their volumes are in assets/audio.json, keyed by the same URLs."""
    hop: SoundRef
    crash: SoundRef
    coin: SoundRef
    stage: SoundRef
    win: SoundRef

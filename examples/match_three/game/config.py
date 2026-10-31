"""Game-wide tunables: config/rules.json and config/sounds.json, read with `ctx.config(...)`."""

from parallax import SoundRef, config, field, record


@config("rules")
class Rules:
    """Board feel and scoring."""
    min_gem_kinds: int = field(3, min=3)
    hint_delay: float = field(8.0, unit="s", doc="Idle time before the board points out a swap.")
    glide_seconds: float = field(0.23, unit="s", doc="A swap, a fall or a refill easing into its cell.")
    clear_seconds: float = field(0.22, unit="s", doc="How long a cleared gem bursts before the fall.")
    points_per_gem: int = field(20)
    points_per_crust: int = field(60)
    points_per_special: int = field(120)
    points_per_move_left: int = field(40)
    chain_step: float = field(1.0, doc="Each cascade step adds this to the score multiplier.")
    bomb_radius: int = field(1, min=1)
    relic_offers: int = field(3, min=1)
    low_moves: int = field(5, doc="The HUD's move count pulses coral at or below this.")
    shake: float = field(0.12, doc="Camera shake for a big wave; grows with the chain.")
    shake_per_chain: float = field(0.05)
    shake_max: float = field(0.5)
    shake_seconds: float = field(0.2, unit="s")
    shake_from_chain: int = field(3, doc="Waves this deep in a cascade shake the camera.")


@record
class Cue:
    """One sound from the hosted asset library and the level it plays at."""
    sound: SoundRef = field()
    volume: float = field(1.0, min=0)


@config("sounds")
class Sounds:
    """Every cue of the template's audio map."""
    swap: Cue = field()
    match_clear: Cue = field()
    cascade_chain: Cue = field(doc="Every wave after the first in a cascade.")
    special_forged: Cue = field()
    special_detonate: Cue = field()
    ice_break: Cue = field(doc="A crust layer chipped.")
    stage_clear: Cue = field()
    relic_pick: Cue = field()
    win: Cue = field()
    lose: Cue = field()

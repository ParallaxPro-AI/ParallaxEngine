"""Game-wide tunables, read from config/rules.json, config/pace.json and config/sounds.json."""

from parallax import ContentRef, SoundRef, config, field, record

from game.content import MazeDef


@config("rules")
class Rules:
    """Which maze, lives, scoring and the hunt's timings."""
    maze: ContentRef[MazeDef] = field()
    lives: int = field(3, min=1)
    pip_score: int = field(10)
    flare_score: int = field(50)
    stalker_score: int = field(200, doc="Doubles for each Stalker eaten on one flare.")
    max_chain: int = field(4, min=1, doc="The doubling stops after this many.")
    level_bonus: int = field(500)
    ready_seconds: float = field(1.5, unit="s", doc="The READY freeze before each round.")
    scatter_seconds: float = field(7.0, unit="s")
    chase_seconds: float = field(20.0, unit="s")
    touch_distance: float = field(0.6, doc="Contact distance, in tiles.")


@record
class Knob:
    """A difficulty multiplier across the pace range."""
    gentlest: float = field(1.0, doc="At pace 0.")
    hardest: float = field(1.0, doc="At pace 1.")


@config("pace")
class PaceTuning:
    """Adaptive Stalker pace. The pace runs 0 (gentlest) .. 1 (hardest) and starts at
    0.5, where every knob is exactly 1.0: the game as tuned in the rules and levels."""
    start: float = field(0.5, min=0, max=1, doc="Must match the `Pace` defaults.")
    lowest: float = field(0.1, min=0, max=1)
    highest: float = field(0.95, min=0, max=1)
    drift_per_minute: float = field(0.04, doc="Pull back toward `start`.")
    smooth_seconds: float = field(2.5, unit="s", doc="How long the pace takes to settle after a nudge.")
    on_caught: float = field(-0.14)
    on_stalker_eaten: float = field(0.02)
    on_fast_clear: float = field(0.12)
    on_slow_clear: float = field(-0.06)
    fast_clear_seconds: float = field(90, unit="s")
    slow_clear_seconds: float = field(170, unit="s")
    stalker_speed: Knob = field()
    fright_seconds: Knob = field()
    scatter_seconds: Knob = field()
    eased_below: float = field(0.38)
    hot_above: float = field(0.62)


@record
class Cue:
    """One sound and the level it plays at."""
    sound: SoundRef = field()
    volume: float = field(1.0, min=0)


@config("sounds")
class Sounds:
    """Every sound cue of the maze (the template's hosted sound files)."""
    pip: Cue = field()
    flare: Cue = field()
    stalker_eaten: Cue = field()
    caught: Cue = field()
    level_cleared: Cue = field()
    won: Cue = field()
    lost: Cue = field()

"""Game-wide tunables, read with `ctx.config(...)`: the difficulty curve, scoring and
feel (config/rules.json), the word pool (config/words.json) and the sound cues
(config/sounds.json)."""

from parallax import ContentRef, SoundRef, config, field, record

from game.content import WordKindDef


@record
class Grade:
    letter: str = field()
    min_accuracy: float = field(min=0, max=1, doc="Fraction of keystrokes that were correct.")


@record
class Rumble:
    """A buzz on the phone or gamepad."""
    strength: float = field(min=0, max=1)
    seconds: float = field(unit="s")


@config("rules")
class Rules:
    base_kind: ContentRef[WordKindDef] = field(doc="Spawns whenever no rarer kind is rolled.")
    rare_kinds: list[ContentRef[WordKindDef]] = field(doc="Rolled in this order.")
    columns: list[float] = field(doc="Column x-centres, left to right (one rail and firewall node each).")
    lives: int = field(4, min=1, doc="Breaches the firewall can take.")
    low_lives: int = field(1, doc="At or below this, the HUD warns.")

    base_speed: float = field(3.2, unit="m/s")
    speed_ramp: float = field(0.05, unit="m/s²", doc="Fall speed gained per second survived.")
    max_speed: float = field(11.0, unit="m/s")
    base_interval: float = field(2.1, unit="s", doc="Time between spawns at the start.")
    interval_ramp: float = field(0.014, doc="Seconds taken off the interval per second survived.")
    min_interval: float = field(0.55, unit="s")

    points_per_word: int = field(120)
    points_per_letter: int = field(14)
    combo_step: float = field(0.2, doc="Multiplier added per word of combo.")
    combo_cap: int = field(10, doc="Combo beyond this adds nothing more.")
    points_per_meter_left: float = field(4.0, doc="Bonus for purging a word far from the firewall.")
    combo_milestone: int = field(10, doc="Every this many words in a row is celebrated.")
    show_combo_from: int = field(4, doc="The HUD's big centre combo shows from this streak on.")

    chars_per_word: int = field(5, doc="The WPM standard: one 'word' is five characters.")
    wpm_min_seconds: float = field(1.0, unit="s", doc="Floor on elapsed time before WPM means anything.")
    grades: list[Grade] = field(doc="Best first; the first one your accuracy reaches is your grade.")

    breach_shake: float = field(0.28)
    breach_shake_seconds: float = field(0.24, unit="s")
    end_shake: float = field(0.5)
    end_shake_seconds: float = field(0.7, unit="s")
    lock_rumble: Rumble = field()
    purge_rumble: Rumble = field()
    breach_rumble: Rumble = field()
    combo_rumble: Rumble = field()
    end_rumble: Rumble = field()


@config("words")
class WordPool:
    """Every word the run can drop. Lower-case a–z only."""
    words: list[str] = field()


@record
class Cue:
    """One sound cue: each play picks one of `clips` and draws its volume and pitch
    within [low, high] (one value: fixed)."""
    clips: list[SoundRef] = field()
    volume: list[float] = field([1.0])
    pitch: list[float] = field([1.0])


@config("sounds")
class Sounds:
    """Every cue of the grid (the template's hosted sound files)."""
    type: Cue = field(doc="A correct letter: three key clicks, so hundreds a run don't repeat.")
    lock: Cue = field(doc="A first letter locked onto a word.")
    error: Cue = field(doc="A wrong letter for the locked word.")
    clear_word: Cue = field(doc="A word purged.")
    breach: Cue = field(doc="A word reached the firewall.")
    combo: Cue = field(doc="A combo milestone, over the purge sound.")
    fail: Cue = field(doc="The last life is gone.")

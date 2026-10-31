from parallax import SoundRef, config, field, record


@config("board")
class Board:
    """Dartboard scoring geometry. Ring edges are fractions of `radius`, measured
    from the bull; past 1.0 is off the board. The model's rings must match."""
    radius: float = field(unit="m")
    inner_bull: float
    outer_bull: float
    treble_inner: float
    treble_outer: float
    double_inner: float
    inner_bull_points: int
    outer_bull_points: int
    sequence: list[int] = field(doc="Wedge numbers clockwise from 12 o'clock.")


@config("release")
class Release:
    """The power band that lands exactly on the reticle. Read by the dart (scatter)
    and by the HUD (the meter's marks)."""
    clean_from: float = field(min=0, max=1)
    clean_to: float = field(min=0, max=1)


@config("house")
class House:
    """The hall's air."""
    draught_bearings: list[float] = field(doc="Directions the draught can blow, degrees (0 = toward the thrower's right).")
    draught_bearing_jitter: float = field(unit="deg")
    gust_seconds_min: float = field(unit="s")
    gust_seconds_max: float = field(unit="s")
    gust_spread: float = field(min=0, doc="Gusts drift the leg's speed by up to this fraction.")
    draught_seed: int = field(doc="Base seed for the hall's air; each match adds the matches played, so a match replays exactly and the next one differs.")


@record
class Cue:
    """One sound of the hall: the file and its level."""
    sound: SoundRef
    volume: float = field(1.0, min=0, max=1)


@config("cues")
class Cues:
    """Every sound the hall plays, by what it means (the template's cue map). The
    files are the template's own, served from the ParallaxPro asset store."""
    throw: Cue = field(doc="The dart leaving the hand; scaled by the throw's power.")
    stick: Cue
    checkout: Cue
    skill: Cue
    penalty: Cue
    ready: Cue
    won: Cue
    missed: Cue

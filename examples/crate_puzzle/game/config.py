"""Game-wide tunables: config/rules.json, read with `ctx.config(Rules)`."""

from parallax import SoundRef, config, field, record


@config("rules")
class Rules:
    step_seconds: float = field(0.07, unit="s", doc="How long a step or push takes to slide.")
    solved_pause: float = field(0.6, unit="s", doc="How long a solved level lingers before the next.")


@record
class Cue:
    """One sound of the yard: the file and its level."""
    sound: SoundRef
    volume: float = field(1.0, min=0, max=1)


@config("cues")
class Cues:
    """Every sound the yard plays, by what it means (the template's cue map). The files
    are the template's own, served from the ParallaxPro asset store."""
    step: Cue
    push: Cue
    place: Cue
    lift: Cue
    blocked: Cue
    undo: Cue
    reset: Cue
    level_clear: Cue
    win: Cue

"""The template's sound cues: each one a catalog sound and the volume the template plays it
at (config/audio.json)."""

from parallax import SoundRef, config, field, record


@record
class Cue:
    sound: SoundRef
    volume: float = field(1, min=0, max=1)


@config("audio")
class Sounds:
    countdown_beep: Cue
    race_go: Cue
    checkpoint: Cue
    lap: Cue
    finish: Cue
    purchase: Cue


def play(ctx, cue: Cue, **kwargs):
    """Play a cue at its volume (`at=` and friends pass through)."""
    ctx.audio.play(cue.sound, volume=cue.volume, **kwargs)

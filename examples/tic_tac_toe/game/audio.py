"""The template's sound cues: each one a catalog sound and the volume the template plays it
at (config/audio.json). The invalid-click and draw cues are the same click at two levels."""

from parallax import SoundRef, config, field, record


@record
class Cue:
    sound: SoundRef
    volume: float = field(1, min=0, max=1)


@config("audio")
class Sounds:
    place: Cue
    taken: Cue
    win: Cue
    lose: Cue
    draw: Cue


def play(ctx, cue: Cue):
    ctx.audio.play(cue.sound, volume=cue.volume)

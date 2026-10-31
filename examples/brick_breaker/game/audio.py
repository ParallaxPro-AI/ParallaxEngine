"""The template's cue sheet: each sound is a catalog asset with the volume the template
plays it at (config/audio.json)."""

from parallax import SoundRef, config, field, record


@record
class Cue:
    sound: SoundRef
    volume: float = field(1, min=0, max=1)


@config("audio")
class Sounds:
    paddle: Cue
    wall: Cue
    brick: Cue
    launch: Cue
    lose_life: Cue
    stage_clear: Cue
    upgrade: Cue
    victory: Cue
    defeat: Cue


def play(ctx, cue: Cue):
    ctx.audio.play(cue.sound, volume=cue.volume)

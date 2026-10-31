"""The template's sound cues: each one a catalog sound and the volume the template plays it
at (config/audio.json). Pickups carry their own cue (content/collectible/*.json)."""

from parallax import SoundRef, config, field, record


@record
class Cue:
    sound: SoundRef
    volume: float = field(1, min=0, max=1)


@config("audio")
class Sounds:
    land: Cue
    jump: Cue
    boing: Cue
    creak: Cue
    stomp: Cue
    hurt: Cue
    fanfare: Cue
    fail: Cue
    plate: Cue
    vault: Cue


def play(ctx, cue: Cue, **kwargs):
    """Play a cue at its volume (`at=` passes through)."""
    ctx.audio.play(cue.sound, volume=cue.volume, **kwargs)

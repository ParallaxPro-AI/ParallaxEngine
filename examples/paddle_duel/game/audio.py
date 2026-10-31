"""The template's sound cues: each one a catalog sound and the volume the template plays it
at (config/audio.json)."""

from parallax import SoundRef, config, field, record


@record
class Cue:
    sound: SoundRef
    volume: float = field(1, min=0, max=1)


@config("audio")
class Sounds:
    paddle_ping: Cue
    wall_click: Cue
    smash_zap: Cue
    point_chime: Cue
    concede: Cue
    second_wind: Cue
    duel_won: Cue
    perk: Cue
    victory: Cue
    defeat: Cue


def play(ctx, cue: Cue, **kwargs):
    """Play a cue at its volume (`at=` and friends pass through)."""
    ctx.audio.play(cue.sound, volume=cue.volume, **kwargs)

"""The template's cue sheet: each sound is a catalog asset with the volume the template
plays it at (config/audio.json)."""

from parallax import SoundRef, config, field, record


@record
class Cue:
    sound: SoundRef
    volume: float = field(1, min=0, max=1)


@config("audio")
class Sounds:
    spark: Cue
    petal_volley: Cue
    guardian_banished: Cue
    boss_banished: Cue
    bloom_collected: Cue
    bomb: Cue
    shield_break: Cue
    wave_begin: Cue
    boss_warning: Cue
    petal_lost: Cue
    shrine_open: Cue
    shrine_pick: Cue
    victory: Cue


def play(ctx, cue: Cue):
    ctx.audio.play(cue.sound, volume=cue.volume)

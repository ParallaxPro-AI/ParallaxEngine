"""The template's cue sheet (data/audio/music.map.json `sfx`): each sound is a catalog asset
with the volume the template plays it at (config/audio.json). The weapons' own reports
live on their content entries (`WeaponDef.report`)."""

from parallax import SoundRef, config, field, record


@record
class Cue:
    sound: SoundRef
    volume: float = field(1, min=0, max=1)


@config("audio")
class Sounds:
    bot_rifle: Cue
    bot_sniper: Cue
    bot_death: Cue
    elite_death: Cue
    player_death: Cue
    upgrade_taken: Cue
    round_start: Cue
    round_clear: Cue
    victory: Cue
    defeat: Cue
    frag_explode: Cue


def play(ctx, cue: Cue, at=None):
    ctx.audio.play(cue.sound, at=at, volume=cue.volume)

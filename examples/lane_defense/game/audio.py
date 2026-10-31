"""The template's cue sheet (data/audio/cues.map.json + bank.json): each sound is the
template's own synth spec (assets/sfx/<name>.synth.json), with the volume the template played it
at (cue volume 0.6 x the emit volume), in config/audio.json."""

from parallax import Context, SoundRef, config, field, record


@record
class Cue:
    sound: SoundRef
    volume: float = field(1, min=0, max=1)


@config("audio")
class Sounds:
    plant: Cue
    dig_up: Cue
    thorn_shoot: Cue
    thorn_hit: Cue
    husk_munch: Cue
    husk_die: Cue
    pollen_pickup: Cue
    gourd_boom: Cue
    wave_start: Cue
    water: Cue
    win: Cue
    lose: Cue


def play(ctx: Context, cue: Cue, *, at=None) -> None:
    ctx.audio.play(cue.sound, at=at, volume=cue.volume)

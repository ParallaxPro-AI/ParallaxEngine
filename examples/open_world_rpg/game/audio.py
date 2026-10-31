"""The template's cue sheet: each sound is a catalog asset with the volume the template plays
it at (config/audio.json). Features share it from the core, like the HUD kit."""

from parallax import Context, SoundRef, config, field, record


@record
class Cue:
    sound: SoundRef
    volume: float = field(1, min=0, max=1)


@config("audio")
class Sounds:
    area_enter: Cue
    sword_hit: Cue
    sword_miss: Cue
    potion: Cue
    level_up: Cue
    purchase: Cue
    quest_complete: Cue
    hero_falls: Cue
    victory: Cue
    defeat: Cue


def play(ctx: Context, cue: Cue) -> None:
    ctx.audio.play(cue.sound, volume=cue.volume)

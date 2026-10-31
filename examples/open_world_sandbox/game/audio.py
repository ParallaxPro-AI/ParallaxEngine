"""The template's cue sheet (config/audio.json): each sound is a catalog asset with the volume the
template plays it at. Weapon shots carry their own sound and volume in `content/weapon`; the car's
engine loop is the car prefab's `audio_source`; the street and radio music are scene / driving data."""

from parallax import SoundRef, config, field, record


@record
class Cue:
    sound: SoundRef
    volume: float = field(1, min=0, max=1)


@config("audio")
class Sounds:
    weapon_draw: Cue
    reload: Cue
    reload_done: Cue
    dry_fire: Cue
    bullet_hit: Cue
    wanted: Cue
    police_shot: Cue
    officer_down: Cue
    pedestrian_down: Cue
    lights_out: Cue


def play(ctx, cue: Cue, at=None):
    ctx.audio.play(cue.sound, at=at, volume=cue.volume)

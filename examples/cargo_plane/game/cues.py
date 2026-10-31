"""The template's cue sheet (config/cues.json): three catalog sounds, each played at the
gain the template gave that moment. The cargo-latch thunk marks signing, the office and
loading; the soft chime marks a delivery, a greased landing and a hangar purchase; the
low splash marks a heavy landing, a missed clock and a lost plane."""

from parallax import Context, Entity, SoundRef, Vec3, config, field, record


@record
class Cue:
    sound: SoundRef
    volume: float = field(1, min=0, max=1)


@config("cues")
class Cues:
    signed: Cue
    office: Cue
    loaded: Cue
    delivered: Cue
    greased: Cue
    upgrade: Cue
    heavy_landing: Cue
    late: Cue
    plane_lost: Cue


def play(ctx: Context, cue: Cue, at: Vec3 | Entity | None = None) -> None:
    ctx.audio.play(cue.sound, at=at, volume=cue.volume)

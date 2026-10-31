"""The template's soundscape as a cue sheet (config/audio.json). Every sound is one of the
template's own synthesized cues (assets/sfx/*.synth.json, converted from its audio bank):
no recordings. A cue lists its variations (one is picked per play), its volume, a pitch
range and whether it is heard from where it happens."""

import random

from parallax import Context, Entity, Player, SoundRef, Vec3, config, field, record, resource


@record
class Cue:
    sounds: list[SoundRef] = field()
    volume: float = field(1, min=0, max=1)
    pitch: list[float] = field([1, 1], doc="Random pitch range [low, high].")
    spatial: bool = field(True, doc="Heard from where it happens (else everywhere at once).")


@config("audio")
class Sounds:
    attack_melee: Cue
    hit_champion: Cue
    minion_hit: Cue
    minion_die: Cue
    last_hit: Cue
    tower_fire: Cue
    structure_fall: Cue
    cast_q: Cue
    cast_w: Cue
    cast_e: Cue
    cast_r: Cue
    cast_heal: Cue
    cc_slow: Cue
    champ_death: Cue
    respawn: Cue
    level_up: Cue
    rank_up: Cue
    buy: Cue
    wave_spawn: Cue
    vo_first_blood: Cue
    vo_kill: Cue
    vo_streak: Cue
    vo_objective: Cue
    vo_structure: Cue
    vo_victory: Cue
    vo_defeat: Cue


def play(ctx: Context, cue: Cue, at: Entity | Vec3 | None = None, *, to: Player | None = None,
         volume: float = 1) -> None:
    """Plays one of the cue's variations (server: forwarded to the clients that hear it)."""
    sound = random.choice(cue.sounds)
    pitch = random.uniform(cue.pitch[0], cue.pitch[1])
    where = at if cue.spatial else None
    ctx.audio.play(sound, at=where, volume=cue.volume * volume, pitch=pitch, to=to,
                   duck=cue.sounds[0].path.startswith("sfx/call_"))


@resource("music_intensity", keep="scene")
class MusicIntensity:
    """How hard the match is going, 0..1 (the template's adaptive-music value): raised by
    blows, casts and deaths on the server, decaying continuously; each client's music
    follows it."""
    value: float = field(0, min=0, max=1, replicate=True)



def excite(ctx: Context, amount: float) -> None:
    """Raises the match music's intensity (server; the template's soundscape `intensity` per event)."""
    music = ctx.get(MusicIntensity)
    music.value = min(1.0, music.value + amount)

"""The template's sound cues (its cues.map.json), each a catalog sound linked by URL
(config/audio.json). Volumes are the template's, at each call."""

from parallax import SoundRef, config


@config("audio")
class Sounds:
    tower_arm: SoundRef
    build_blocked: SoundRef
    tower_build: SoundRef
    tower_upgrade: SoundRef
    tower_sell: SoundRef
    enemy_die: SoundRef
    enemy_leak: SoundRef
    bonus_gold: SoundRef
    boss_warning: SoundRef
    spot_move: SoundRef
    victory: SoundRef
    defeat: SoundRef

from parallax import field, resource


@resource("sound_cooldowns", keep="scene")
class SoundCooldowns:
    """When each rapid-fire cue last played (server)."""
    attack_melee: float = field(-100, unit="s")
    hit_champion: float = field(-100, unit="s")
    minion_hit: float = field(-100, unit="s")
    tower_fire: float = field(-100, unit="s")
    minion_die: float = field(-100, unit="s")


@resource("music_state", keep="scene")
class MusicState:
    """Which music this client last started: 0 none yet, 1 the menu bed, 2 the match bed."""
    playing: int = field(0)

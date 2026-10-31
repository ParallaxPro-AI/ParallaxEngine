"""Run-wide tuning (config/match.json)."""

from parallax import Localized, config, field, record


@record
class StreakTier:
    at: int
    shout: Localized


@record
class Sector:
    """The HUD's sector name: the first sector whose `below_z` is south of the player."""

    name: Localized
    below_z: float = field(1000, unit="m")


@config("match")
class MatchRules:
    lives: int
    respawn_delay: float = field(unit="s")
    bot_respawn_delay: float = field(unit="s")
    armor_max: float
    armor_absorb: float = field(min=0, max=1, doc="Share of each hit that plating soaks up.")
    regen_delay: float = field(unit="s")
    regen_rate: float = field(doc="Health per second once regenerating.")
    streak_step: float = field(doc="Score multiplier added per frag in a streak.")
    streak_max: float
    streak_tiers: list[StreakTier]
    upgrade_draw: int
    bot_names: list[str]
    sectors: list[Sector]
    feed_seconds: float = field(2.6, unit="s", doc="How long a centre-feed line stays.")
    banner_seconds: float = field(3, unit="s", doc="How long the round-start banner stays.")

"""Voyage-wide tunables (config/voyage.json)."""

from enum import Enum

from parallax import ContentRef, SoundRef, config, field, record

from game.content import FactionDef, LegDef


@config("voyage")
class VoyageRules:
    legs: list[ContentRef[LegDef]] = field(doc="Sailed in this order.")
    crew: int = field(3, min=1, doc="Sinkings the fleet survives, shared by every captain.")
    refit_offers: int = field(3, min=1)
    treasure_radius: float = field(700, unit="m")
    harbour_radius: float = field(22, unit="m", doc="No chests this close to the berths.")
    pickup_radius: float = field(4, unit="m")
    respawn_delay: float = field(5, unit="s")
    storm_duration: float = field(35, unit="s")
    storm_sail_scale: float = field(0.7, min=0, max=1)
    storm_range_scale: float = field(0.78, min=0, max=1)
    water_level: float = field(-1.05, unit="m")
    max_armor: float = field(0.7, min=0, max=1)


class Deed(Enum):
    """Something that happened at sea that the powers of the sea notice."""
    KILL_GHOST = "kill_ghost"
    KILL_KRAKEN = "kill_kraken"
    KILL_SHARK = "kill_shark"
    HAUL = "haul"
    """One chest scooped aboard."""
    CONTRACT_GHOST = "contract_ghost"
    CONTRACT_MONSTER = "contract_monster"
    CONTRACT_TREASURE = "contract_treasure"
    LEG_CLEARED = "leg_cleared"
    SHIP_SUNK = "ship_sunk"


@record
class DeedRow:
    deed: Deed
    faction: ContentRef[FactionDef]
    amount: float


@config("standing")
class StandingRules:
    """How each deed moves each faction (config/standing.json)."""
    deeds: list[DeedRow] = field(doc="Rows for the same deed all apply.")


@config("sounds")
class Sounds:
    """The voyage's sounds: the template's own files (its cue map and ship/monster
    behaviours), served from the ParallaxPro asset store. The splash stays a local file
    (the template synthesised it)."""
    refit_pick: SoundRef
    leg_start: SoundRef
    kraken_rise: SoundRef
    hull_hit: SoundRef
    cannon: SoundRef
    win: SoundRef
    defeat: SoundRef
    ship_sank: SoundRef
    bounty: SoundRef
    refit_open: SoundRef
    crew_lost: SoundRef
    leg_cleared: SoundRef
    treasure: SoundRef
    thunder: SoundRef

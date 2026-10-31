"""Content registries: the three legs of the voyage and the refit shelf. Text fields are
`Localized`, written inline in each entry's JSON."""

from enum import Enum

from parallax import ContentRef, Localized, SceneRef, Tag, content, field, record


@content("leg")
class LegDef:
    """One leg of the voyage: its own sea, a clock, a gold quota and a bounty. Clear
    both before the sand runs out to sail on."""
    name: Localized = field()
    brief: Localized = field()
    bounty_label: Localized = field()
    scene: SceneRef = field()
    duration: float = field(unit="s")
    gold_quota: int = field(min=0)
    treasure_count: int = field(min=0, doc="Chests kept floating; topped up below 60%.")
    treasure_value: int = field(min=0)
    bounty_tag: Tag = field(doc="Which hulls count towards the bounty.")
    bounty_count: int = field(min=1)
    storm_chance: float = field(0, min=0, unit="1/min")
    enemy_damage_scale: float = field(1, min=0)


class Stat(Enum):
    MAX_HULL = "max_hull"
    ARMOR = "armor"
    HULL_REGEN = "hull_regen"
    CANNON_DAMAGE = "cannon_damage"
    CANNON_RANGE = "cannon_range"
    RELOAD_CUT = "reload_cut"
    BROADSIDE = "broadside"
    MAX_SPEED = "max_speed"
    PICKUP_RADIUS = "pickup_radius"
    TREASURE_BONUS = "treasure_bonus"
    BOUNTY_BONUS = "bounty_bonus"
    CREW = "crew"


@content("upgrade")
class UpgradeDef:
    """A refit card. Taking it adds `amount` to `stat` for every ship, up to `max_level` times."""
    name: Localized = field()
    blurb: Localized = field()
    stat: Stat = field()
    amount: float = field()
    max_level: int = field(min=1)


class ContractKind(Enum):
    GHOST = "ghost"
    """Sink hulls tagged ghost."""
    MONSTER = "monster"
    """Slay krakens or sharks."""
    TREASURE = "treasure"
    """Raise the cursed hoards the contract itself scatters around the ship."""


@content("contract", order="number")
class ContractDef:
    """A contract-board job (Q at sea). Contracts are taken in order and repeat; one is
    open at a time for the whole fleet. Its gold is banked against the leg's quota."""
    number: int = field()
    label: Localized = field()
    kind: ContractKind = field()
    goal: int = field(min=1)
    gold: int = field(min=0)
    hoards: int = field(0, min=0, doc="Treasure contracts: hoards scattered when it's taken.")
    radius: float = field(0, unit="m", doc="Treasure contracts: how far out the first hoard lies (+18 m each).")


class PerkKind(Enum):
    PCT = "pct"
    CARDS = "cards"


@record
class Rank:
    at: float
    name: Localized
    perk: float = field(0, doc="What this rung is worth (see the faction's perk).")
    hostile: bool = field(False)


@record
class Share:
    faction: ContentRef["FactionDef"]
    share: float


@content("faction", order="number")
class FactionDef:
    """One of the three powers of the sea. Standing is per voyage. A change of N here
    also moves each ally by N × share and each rival by −N × share (one hop). The rank
    is the highest rung at or below the standing; its `perk` feeds one knob: the
    Crown's bounty multiplier, the Guild's refit shelf, the Brethren's hoard value."""
    number: int = field()
    name: Localized = field()
    start: float = field(0)
    min: float = field(-100)
    max: float = field(100)
    allies: list[Share] = field([])
    rivals: list[Share] = field([])
    ranks: list[Rank] = field()
    perk_label: Localized = field()
    perk_kind: PerkKind = field(PerkKind.PCT)

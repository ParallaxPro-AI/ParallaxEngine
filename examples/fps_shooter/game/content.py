"""Content registries: weapons, bot archetypes, rounds, upgrade cards and pickups."""

from enum import Enum

from parallax import Color, ContentRef, Localized, PrefabRef, content, field, record

from game.audio import Cue


class WeaponKind(Enum):
    HITSCAN = "hitscan"
    THROWN = "thrown"


@content("weapon", order="slot")
class WeaponDef:
    """A player weapon. `HITSCAN` guns trace a ray, `THROWN` weapons spawn `projectile`."""

    name: Localized
    short: Localized
    slot: int = field(min=1, doc="Registry order: the number key that selects it.")
    kind: WeaponKind
    damage: float = field(min=0)
    fire_interval: float = field(unit="s")
    automatic: bool = field(False, doc="Keeps firing while the trigger is held.")
    magazine: int = field(min=1)
    reserve: int = field(min=0, doc="Spare rounds at the start of a run.")
    max_reserve: int = field(min=0)
    reload_time: float = field(0, unit="s")
    range: float = field(200, unit="m")
    spread: float = field(0, unit="deg", doc="Random cone when hip-firing.")
    recoil: float = field(0, unit="deg", doc="Upward kick per shot.")
    zoom_fov: float = field(0, unit="deg", doc="Aim-down-sights/scope field of view; 0 = no zoom.")
    zoom_time: float = field(0.2, unit="s")
    scoped: bool = field(False, doc="Zooming shows the scope overlay instead of the crosshair.")
    report: Cue | None = field(None, doc="The shot's sound; thrown weapons have none.")
    tracer: Color = field(Color.hex("#ffd24d"))
    projectile: PrefabRef | None = field(None)
    view: PrefabRef | None = field(None, doc="The first-person item held while it is selected; None: empty hands.")
    throw_speed: float = field(0, unit="m/s")


@content("bot")
class BotDef:
    """A bot archetype. Its numbers are its personality: a rusher closes to 3 m and
    brawls, a marksman parks at 24 m and duels, a heavy grinds forward."""

    name: Localized
    look: dict[str, str] = field({}, doc="Soldier model options (headgear, gear, jacket, trousers) that make the archetype readable.")
    jacket_tint: Color | None = field(None, doc="The archetype colour over the jacket (the template's tint on the uniform).")
    scale: float = field(1)
    health: float = field(min=1)
    damage: float = field(min=0)
    fire_interval: float = field(unit="s")
    accuracy: float = field(min=0, max=1, doc="Chance a shot is aimed true.")
    reaction: float = field(unit="s", doc="Sight time before the first shot.")
    sight_range: float = field(unit="m")
    shoot_range: float = field(unit="m")
    move_speed: float = field(unit="m/s")
    stop_range: float = field(unit="m", doc="Closes to this distance, then circles.")
    patrol_radius: float = field(unit="m")
    memory: float = field(3, unit="s", doc="How long it hunts a target it lost sight of.")
    takes_cover: bool = field(True)
    flanks: bool = field(False, doc="Works around cover to the side instead of straight in.")
    relentless: bool = field(False, doc="Never loses interest (the boss).")
    score: int
    tracer: Color
    elite: bool = field(False, doc="The boss: a heavier death sound and a pink kill-feed line.")


@record
class RosterEntry:
    bot: ContentRef[BotDef]
    count: int = field(1, min=1)


@content("round", order="number")
class RoundDef:
    number: int
    name: Localized
    tagline: Localized
    frag_target: int = field(min=1)
    roster: list[RosterEntry]
    damage_mul: float = field(1, doc="Bot damage this round.")
    accuracy_mul: float = field(1, doc="Bot accuracy this round.")


@record
class AmmoGrant:
    weapon: ContentRef[WeaponDef]
    rounds: int


@content("upgrade")
class UpgradeDef:
    """A between-rounds card. Multipliers multiply, everything else adds."""

    name: Localized
    description: Localized
    icon: str
    damage_dealt_mul: float = field(1)
    damage_taken_mul: float = field(1)
    bot_accuracy_mul: float = field(1)
    bot_health_mul: float = field(1)
    bot_respawn_add: float = field(0, unit="s")
    score_mul: float = field(1)
    armor_start: float = field(0)
    armor_on_kill: float = field(0)
    ammo_on_kill: list[AmmoGrant] = field([])
    streak_step_add: float = field(0)
    lives: int = field(0)


@content("pickup")
class PickupDef:
    label: Localized
    respawn: float = field(unit="s")
    ammo: list[AmmoGrant] = field([])
    armor: float = field(0)
    cue: Cue

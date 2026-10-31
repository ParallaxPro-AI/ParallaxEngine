"""Content registries: floors, room kinds, enemies and their tactics, shots, items,
loot tables and vault boons."""

from enum import Enum

from parallax import Color, ContentRef, Localized, PrefabRef, SoundRef, content, field, record


class Effect(Enum):
    """What an item or boon does, `amount` times (see game/effects.py)."""
    COINS = "coins"
    HEALTH = "health"
    KEYS = "keys"
    BOMBS = "bombs"
    MAX_HEALTH = "max_health"
    FIRE_INTERVAL = "fire_interval"
    SHARD_DAMAGE = "shard_damage"
    SHARD_SPEED = "shard_speed"
    MOVE_SPEED = "move_speed"


class Move(Enum):
    CHASE = "chase"
    STANDOFF = "standoff"
    RETREAT = "retreat"
    STRAFE = "strafe"
    LUNGE = "lunge"
    HOLD = "hold"


class Attack(Enum):
    NONE = "none"
    SHOT = "shot"
    BURST = "burst"
    SUMMON = "summon"


class Elites(Enum):
    """Whether a room's squad may be promoted to elites."""
    NEVER = "never"
    SOMETIMES = "sometimes"
    ALWAYS = "always"


@content("item")
class ItemDef:
    """Anything the keeper can pick up, buy or draft. `effect` + `amount` is what it does."""
    name: Localized
    effect: Effect
    amount: float = field()
    mesh: str = field("box", choices=["box", "sphere", "cylinder", "cone"])
    color: Color = field()
    relic: bool = field(False, doc="A permanent build piece: listed in the HUD, offered in drafts.")
    blurb: Localized | None = field(None)


@record
class Drop:
    item: ContentRef[ItemDef] | None = field(None, doc="None is a roll that drops nothing.")
    weight: float = field(1)
    count: tuple[int, int] = field((1, 1), doc="How many pickups to scatter (a handful of coins).")


@content("loot")
class LootTable:
    """`rolls` weighted draws from `drops`."""
    rolls: int = field(1, min=1)
    drops: list[Drop] = field()


@content("shot")
class ShotDef:
    """An enemy projectile."""
    prefab: PrefabRef
    speed: float = field(unit="m/s")
    damage: int = field(1, doc="Half-hearts.")
    lifetime: float = field(unit="s")


@record
class Tactic:
    """One branch of an enemy's brain. The first tactic whose conditions hold and whose
    attack is ready decides this frame's movement and attack."""
    move: Move = field(Move.CHASE)
    attack: Attack = field(Attack.NONE)
    within: float = field(0, unit="m", doc="Only while the keeper is this close (0 = any distance).")
    wounded: bool = field(False, doc="Only below EnemyDef.enrage_below health.")


@content("enemy")
class EnemyDef:
    """A foe's stats and its ordered tactics (see behaviors/foe_brain.py)."""
    name: Localized
    prefab: PrefabRef
    hp: float = field(min=1)
    contact_damage: int = field(1, doc="Half-hearts per touch.")
    move_speed: float = field(unit="m/s")
    standoff: float = field(0, unit="m", doc="Distance the `standoff` move holds.")
    lunge_speed: float = field(2, doc="Speed multiplier while lunging.")
    enrage_below: float = field(0.5, min=0, max=1)
    shot: ContentRef[ShotDef] | None = field(None)
    shot_cooldown: float = field(3, unit="s")
    burst_count: int = field(3, min=1)
    burst_spread: float = field(26, unit="deg")
    summon: ContentRef["EnemyDef"] | None = field(None)
    summon_count: int = field(2)
    summon_cooldown: float = field(8, unit="s")
    boss: bool = field(False)
    tactics: list[Tactic] = field()


@content("room")
class RoomKindDef:
    """What a kind of room does when the keeper walks in. Ids match the floor plan's
    room kinds (start, combat, shop, gauntlet, boss)."""
    color: Color
    fights: bool = field(False, doc="Doors shut and a squad spawns until it's dead.")
    elites: Elites = field(Elites.NEVER)
    clear_reward: ContentRef[LootTable] | None = field(None)
    engage_text: Localized | None = field(None)
    engage_sound: SoundRef | None = field(None)


@content("floor")
class FloorDef:
    """One floor of the cellar: its layout, its squads and its difficulty."""
    name: Localized
    tint: Color
    rooms: int = field(min=6)
    loops: float = field(0.1, min=0, max=1, doc="Chance of an extra door between ordinary rooms.")
    has_gauntlet: bool = field(False)
    locked_chests: int = field(0)
    locks: int = field(1, min=1, doc="Locked rooms: lock 0 is the boss, more lock random rooms.")
    enemy_hp_mult: float = field(1)
    boss_hp_mult: float = field(1)
    shop_price_mult: float = field(1)
    elite_chance: float = field(0, min=0, max=1)
    squads: dict[ContentRef[RoomKindDef], dict[ContentRef[EnemyDef], int]] = field(
        doc="Per room kind: which enemies spawn, and how many.")


@content("boon")
class BoonDef:
    """A permanent vault upgrade, bought between runs. Applied `level` times at run start."""
    name: Localized
    blurb: Localized
    effect: Effect
    amount: float = field()
    costs: list[int] = field(doc="Price of each level; its length is the max level.")

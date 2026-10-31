"""The run's global knobs (config/rules.json) and lookups into them."""

from parallax import Color, ContentRef, Context, PrefabRef, SoundRef, config, field, record

from game.content import FloorDef, ItemDef, LootTable
from game.resources import Run


@record
class StockRow:
    """One possible shop offer: which pedestal, what, how much, on which floors."""
    slot: int = field()
    item: ContentRef[ItemDef] = field()
    price: int = field()
    floors: list[ContentRef[FloorDef]] = field()


@record
class CoverTile:
    """One tile of a fight room's cover layout (see game/cover_layout.py)."""
    id: str = field()
    prefab: PrefabRef | None = field(None, doc="None: open floor.")
    weight: float = field(1)
    n: str = field("o", doc="Socket on each side: o open, w wall run.")
    e: str = field("o")
    s: str = field("o")
    w: str = field("o")


@config("rules")
class Rules:
    """The starting loadout, room geometry, cover, elites and the shop."""
    floors: list[ContentRef[FloorDef]]
    cover_tiles: list[CoverTile]
    breakables: list[PrefabRef]
    lock_colors: list[Color]
    breakable_loot: ContentRef[LootTable]
    shop_stock: list[StockRow]
    elite_tint: Color
    elite_loot: ContentRef[LootTable]
    chest_loot: ContentRef[LootTable]
    start_coins: int = field(0)
    start_bombs: int = field(1)
    start_keys: int = field(0)
    move_speed: float = field(7, unit="m/s")
    fire_interval: float = field(0.32, unit="s")
    shard_damage: float = field(4)
    shard_speed: float = field(14, unit="m/s")
    shard_lifetime: float = field(0.65, unit="s")
    min_fire_interval: float = field(0.1, unit="s")
    max_move_speed: float = field(14, unit="m/s")
    win_coin_bonus: int = field(40)

    room_size: float = field(20, unit="m")
    door_width: float = field(4, unit="m")
    grid_radius: int = field(3, doc="Rooms stay within this many cells of the start.")
    enter_margin: float = field(3, unit="m", doc="How far past the door a room engages.")
    floor_tint_strength: float = field(0.35, min=0, max=1)
    cover_size: int = field(8, doc="A fight room's interior is cover_size x cover_size cells.")
    cover_cell: float = field(2, unit="m")
    cover_centre: int = field(2, doc="The centre block kept open (the boss's and the key's spot).")
    cover_restarts: int = field(40)
    spawn_clearance: float = field(3.5, unit="m", doc="Nothing spawns this close to the keeper.")
    breakables_per_room: int = field(3)
    brazier_inset: float = field(1.1, unit="m", doc="Braziers stand this far in from each corner.")
    chest_offset: float = field(5, unit="m")
    loot_scatter: float = field(1.2, unit="m", doc="Drops land up to this far from where they fell.")
    shop_spacing: float = field(4, unit="m")

    elite_hp_mult: float = field(2.2)
    elite_damage_bonus: int = field(1)
    elite_scale: float = field(1.35)
    max_adds: int = field(4, doc="Most summoned adds alive per boss.")
    summon_radius: float = field(2.4, unit="m")
    draft_size: int = field(3)


def current_floor(ctx: Context) -> FloorDef:
    return ctx.config(Rules).floors[ctx.get(Run).floor].data


def is_last_floor(ctx: Context) -> bool:
    return ctx.get(Run).floor == len(ctx.config(Rules).floors) - 1


@config("sounds")
class Sounds:
    """The cellar's sounds: the template's own files (its cue map), served from the
    ParallaxPro asset store; their volumes are in assets/audio.json under the same URLs."""
    shard_fire: SoundRef
    enemy_die: SoundRef
    hurt: SoundRef
    death: SoundRef
    coin: SoundRef
    pickup: SoundRef
    relic: SoundRef
    buy: SoundRef
    denied: SoundRef
    bomb: SoundRef
    room_clear: SoundRef
    descend: SoundRef
    victory: SoundRef

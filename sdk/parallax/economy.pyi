"""Economy (plugins.economy()): what games trade, carry and find.

Wallets. A pool is a named amount ("gold", "wood", "mana") in a `Wallet` component or in
the game-wide bank (`ctx.economy.bank`, same methods). `caps` bound pools; `generators`
pay `amount` every `every` seconds (times the live entities tagged `per_tag`: mines,
farms). Every change raises `PoolChanged`; `pay({"gold": 5, "wood": 2})` is all or nothing.

Items are content (content/item/*.json). An `Inventory` holds `size` slots of stacks (up to
the item's `max_stack`); its first `hotbar` slots are the hotbar (`select`, `held`);
`equip` moves an item into one of `equip_slots` and applies its `bonuses` as stat
modifiers on the owner until `unequip` (DESIGN §4.23) — saved with it.

Shops (content/shop/*.json) are sold by a `Shopkeeper`: prices in the shop's `currency`
pool, limited `quantity` restocked `restock` seconds after a sale, buy-back at
`item.value × sell_rate`. Loot tables (content/loot_table/*.json) roll `guaranteed`
entries, then `rolls`..`rolls_max` weighted draws (`nothing` is an empty draw's weight),
each an item, a pool or a nested table — on the plugin's seeded random, so replays and
playtests roll the same. Upgrade drafts (content/upgrade/*.json) on an `Upgrades`
component: `draft(3)` offers different upgrades by weight whose `requires` are picked and
`max_picks` not reached; `pick` applies their bonuses permanently.

In the world: a `Pickup` is collected by the nearest Inventory/Wallet holder within
`radius` (magnet: flies to it from `magnet`).

    @behavior("chest")
    class Chest(Behavior):
        @on(Interacted)
        def opened(self, ctx, e: Interacted):
            ctx.economy.grant(Content.loot_table.chest, e.source)

Elsewhere: projectiles are combat's (`Projectile`, `ctx.combat.fire`); doors, whose keys
are items, are interaction's (`Door`); wave spawners are spawning's (`Spawner`).
"""

from parallax import (
    ContentRef, EngineComponent, Entity, ImageRef, Localized, PrefabRef, Tag, Vec3,
    component, content, event, field, record,
)


@record
class StatBonus:
    """A stat change: component id + field, as in stat modifiers."""
    component: str
    field: str
    multiply: float = field(1)
    add: float = field(0)


@content("item")
class ItemDef:
    """Built-in content kind; games add entries in content/item/*.json."""
    name: Localized
    icon: ImageRef | None = field(None)
    max_stack: int = field(1, min=1)
    value: int = field(0, min=0, doc="Base worth; shops buy it back at value × sell_rate.")
    equip_slot: str | None = field(None, doc="The equip slot it goes in; None: not equippable.")
    bonuses: list[StatBonus] = field([], doc="Applied to the wearer while equipped.")
    pickup: PrefabRef | None = field(None, doc="Prefab `ctx.economy.drop` spawns for it (has a Pickup).")


@record
class LootEntry:
    """Exactly one of item, pool or table; min..max of it (a table: rolled that many times)."""
    item: ContentRef[ItemDef] | None = field(None)
    pool: str | None = field(None)
    table: ContentRef[LootTableDef] | None = field(None)
    weight: float = field(1, min=0)
    min: int = field(1, min=0)
    max: int = field(1, min=0)


@content("loot_table")
class LootTableDef:
    """Built-in content kind; games add entries in content/loot_table/*.json."""
    rolls: int = field(1, min=0)
    rolls_max: int | None = field(None, doc="Draw a whole number of rolls between rolls and this.")
    nothing: float = field(0, min=0, doc="Weight of a draw that drops nothing.")
    unique: bool = field(False, doc="Never draw the same entry twice in one roll.")
    entries: list[LootEntry] = field([])
    guaranteed: list[LootEntry] = field([])


@record
class ShopStock:
    item: ContentRef[ItemDef]
    price: int = field(min=0)
    quantity: int = field(-1, min=-1, doc="-1: unlimited.")


@content("shop")
class ShopDef:
    """Built-in content kind; games add entries in content/shop/*.json."""
    name: Localized
    currency: str = field(doc="The wallet pool prices are paid from.")
    stock: list[ShopStock] = field([])
    sell_rate: float = field(0.5, min=0, doc="0: the shop buys nothing.")
    restock: float | None = field(None, unit="s", doc="After a sale, limited stock refills this much later.")


@content("upgrade")
class UpgradeDef:
    """Built-in content kind; games add entries in content/upgrade/*.json."""
    name: Localized
    rarity: str = field("common")
    weight: float = field(1, min=0)
    max_picks: int = field(1, min=1)
    requires: list[ContentRef[UpgradeDef]] = field([])
    bonuses: list[StatBonus] = field([], doc="Applied permanently (stacked) on each pick.")


@record
class Generator:
    pool: str
    amount: float = field(1)
    every: float = field(1, min=0.001, unit="s")
    per_tag: Tag | None = field(None, doc="Pay once per live entity with this tag.")


@component("wallet")
class Wallet(EngineComponent):
    amounts: dict[str, float] = field({})
    caps: dict[str, float] = field({}, doc="Pool → most it holds; unlisted: no cap.")
    generators: list[Generator] = field([])
    clocks: list[float] = field([], doc="Seconds into each generator's period (kept by the engine).")

    def amount(self, pool: str) -> float: ...
    def earn(self, pool: str, amount: float) -> float:
        """Adds up to the cap; returns what was added."""
    def spend(self, pool: str, amount: float) -> bool:
        """False (and nothing spent) when it can't afford it."""
    def can_afford(self, costs: dict[str, float]) -> bool: ...
    def pay(self, costs: dict[str, float]) -> bool:
        """All costs or none."""


@record
class ItemStack:
    item: ContentRef[ItemDef] | None = field(None)
    count: int = field(0, min=0)


@component("inventory")
class Inventory(EngineComponent):
    size: int = field(20, min=1)
    hotbar: int = field(0, min=0, doc="The first N slots are the hotbar.")
    selected: int = field(0, min=0, doc="The hotbar slot in hand.")
    equip_slots: list[str] = field([])
    slots: list[ItemStack] = field([], doc="Slot contents; the rest are empty.")
    equipped: dict[str, ContentRef[ItemDef]] = field({}, doc="Equip slot → item worn (kept by the engine).")

    def add(self, item: ContentRef[ItemDef], count: int = 1) -> int:
        """Fills stacks, then empty slots; returns how many didn't fit."""
    def remove(self, item: ContentRef[ItemDef], count: int = 1) -> bool:
        """All or nothing."""
    def count(self, item: ContentRef[ItemDef]) -> int: ...
    def has(self, item: ContentRef[ItemDef], count: int = 1) -> bool: ...
    def room(self, item: ContentRef[ItemDef]) -> int:
        """How many more of it fit."""
    def item_at(self, slot: int) -> ContentRef[ItemDef] | None: ...
    def count_at(self, slot: int) -> int: ...
    def move(self, source: int, destination: int) -> None:
        """Swap two slots, or merge into the destination when both hold the same item."""
    def select(self, slot: int) -> None: ...
    @property
    def held(self) -> ContentRef[ItemDef] | None:
        """The item in the selected hotbar slot."""
    def equip(self, item: ContentRef[ItemDef], *, slot: str | None = None) -> bool:
        """Into its equip slot; what was worn there goes back to the slots. False when it isn't
        carried or there's no room for what comes off."""
    def unequip(self, slot: str) -> bool: ...
    def worn(self, slot: str) -> ContentRef[ItemDef] | None: ...


@component("shopkeeper")
class Shopkeeper(EngineComponent):
    shop: ContentRef[ShopDef] = field()
    stock: dict[str, int] = field({}, doc="Units left of limited items (kept by the engine).")
    restock_at: float = field(-1, doc="When stock refills; -1: not pending (kept by the engine).")

    def buy(self, buyer: Entity, item: ContentRef[ItemDef], count: int = 1) -> bool:
        """From the buyer's Wallet into its Inventory; all or nothing."""
    def sell(self, seller: Entity, item: ContentRef[ItemDef], count: int = 1) -> bool: ...
    def price(self, item: ContentRef[ItemDef]) -> int: ...
    def sell_price(self, item: ContentRef[ItemDef]) -> int: ...
    def remaining(self, item: ContentRef[ItemDef]) -> int:
        """-1 when unlimited."""
    @property
    def offers(self) -> list[ContentRef[ItemDef]]: ...


@component("upgrades")
class Upgrades(EngineComponent):
    picked: dict[str, int] = field({}, doc="Upgrade → times picked (kept by the engine).")
    offer: list[ContentRef[UpgradeDef]] = field([], doc="The draft on offer (kept by the engine).")

    def draft(self, count: int = 3, *, choices: list[ContentRef[UpgradeDef]] | None = None) -> list[ContentRef[UpgradeDef]]:
        """Offer up to `count` different eligible upgrades (from `choices`, else all)."""
    def pick(self, upgrade: ContentRef[UpgradeDef]) -> None:
        """One of the offer; applies its bonuses and clears the offer."""
    def grant(self, upgrade: ContentRef[UpgradeDef]) -> bool:
        """Apply one without a draft (bought, scripted); False when not eligible."""
    def picks(self, upgrade: ContentRef[UpgradeDef]) -> int: ...


@component("pickup")
class Pickup(EngineComponent):
    """Exactly one of `item` or `pool`."""
    item: ContentRef[ItemDef] | None = field(None)
    pool: str | None = field(None)
    count: float = field(1, min=0)
    radius: float = field(1, min=0, unit="m")
    magnet: float = field(0, min=0, unit="m", doc="Flies to a collector this close.")
    magnet_speed: float = field(8, min=0, unit="m/s")
    collector_tag: Tag | None = field(None, doc="Only entities with this tag collect it.")
    respawn: float | None = field(None, min=0, unit="s", doc="Hidden, then back this much later; None: destroyed.")
    respawn_at: float = field(-1, doc="Kept by the engine.")


class Drop:
    item: ContentRef[ItemDef] | None
    pool: str | None
    count: int


class Bank:
    """The game-wide wallet (the `economy_bank` resource)."""
    amounts: dict[str, float]
    def amount(self, pool: str) -> float: ...
    def earn(self, pool: str, amount: float) -> float: ...
    def spend(self, pool: str, amount: float) -> bool: ...
    def can_afford(self, costs: dict[str, float]) -> bool: ...
    def pay(self, costs: dict[str, float]) -> bool: ...


class EconomyApi:
    bank: Bank
    def roll(self, table: ContentRef[LootTableDef]) -> list[Drop]: ...
    def grant(self, table: ContentRef[LootTableDef], to: Entity) -> list[Drop]:
        """Roll into `to`'s Inventory and Wallet; returns what didn't fit."""
    def drop(self, table: ContentRef[LootTableDef], at: Vec3, *, spread: float = 0.6,
             pool_prefab: PrefabRef | None = None) -> list[Entity]:
        """Spawn each drop's pickup prefab around `at` (pools use `pool_prefab`)."""


@event("pool_changed", target="entity")
class PoolChanged:
    entity: Entity | None
    """The wallet's entity; None for the bank."""
    pool: str
    amount: float
    delta: float

@event("items_changed", target="entity")
class ItemsChanged:
    entity: Entity

@event("item_equipped", target="entity")
class ItemEquipped:
    entity: Entity
    item: ContentRef[ItemDef]
    slot: str

@event("item_unequipped", target="entity")
class ItemUnequipped:
    entity: Entity
    item: ContentRef[ItemDef]
    slot: str

@event("item_bought", target="entity")
class ItemBought:
    entity: Entity
    """The shopkeeper."""
    source: Entity
    """The buyer."""
    item: ContentRef[ItemDef]
    count: int
    price: int

@event("item_sold", target="entity")
class ItemSold:
    entity: Entity
    """The shopkeeper."""
    source: Entity
    """The seller."""
    item: ContentRef[ItemDef]
    count: int
    price: int

@event("upgrade_picked", target="entity")
class UpgradePicked:
    entity: Entity
    upgrade: ContentRef[UpgradeDef]
    picks: int

@event("picked_up", target="entity")
class PickedUp:
    entity: Entity
    """The pickup."""
    source: Entity
    """Who collected it."""
    item: ContentRef[ItemDef] | None
    pool: str | None
    count: float

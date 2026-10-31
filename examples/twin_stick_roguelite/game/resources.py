"""The run in progress (reset each run) and the vault (kept forever)."""

from enum import Enum

from parallax import ContentRef, field, resource

from game.content import BoonDef, ItemDef


class Outcome(Enum):
    WON = "won"
    FELL = "fell"


@resource("run")
class Run:
    floor: int = field(0, doc="Index into Rules.floors.")
    health: float = field(0, doc="The keeper's health in half-hearts, carried down between floors.")
    max_health: float = field(0, doc="Carried down with `health`.")
    coins: int = field(0)
    bombs: int = field(0)
    keys: int = field(0)
    move_speed: float = field(0, unit="m/s")
    fire_interval: float = field(0, unit="s")
    shard_damage: float = field(0)
    shard_speed: float = field(0, unit="m/s")
    relics: list[ContentRef[ItemDef]] = field([])
    draft: list[ContentRef[ItemDef]] = field([], doc="Relics offered after a floor's boss.")
    outcome: Outcome | None = field(None)
    coins_banked: int = field(0)


@resource("vault", keep="profile")
class Vault:
    coins: int = field(0)
    levels: dict[ContentRef[BoonDef], int] = field({})
    runs: int = field(0)
    wins: int = field(0)
    best_floor: int = field(0)
    boss_kills: int = field(0)
    lifetime_coins: int = field(0)

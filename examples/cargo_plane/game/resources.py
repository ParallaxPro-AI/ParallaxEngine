"""Game-wide state. Run fields are what the "career" save slot holds, so Start Engine on
the title picks the career up where it was left."""

from enum import Enum

from parallax import ContentRef, field, record, resource

from game.content import CargoDef, IslandDef


@record
class Offer:
    cargo: ContentRef[CargoDef] = field()
    origin: ContentRef[IslandDef] = field()
    destination: ContentRef[IslandDef] = field()
    leg: float = field(unit="m")
    pay: int = field(min=0)
    deadline: float = field(unit="s")


class Outcome(Enum):
    AIRFIELD_BOUGHT = "airfield_bought"
    GROUNDED = "grounded"


@resource("career")
class Career:
    money: float = field(0, doc="The bank.")
    deliveries: int = field(0)
    distance_flown: float = field(0, unit="m")
    airframes_lost: int = field(0)
    upgrades: dict[str, int] = field({}, doc="Upgrade id -> tiers bought.")
    outcome: Outcome | None = field(None, doc="Set when the career ends; the game-over screen follows it.")


@resource("board")
class Board:
    """The contract board at the island you last worked from, and the job on board."""
    island: ContentRef[IslandDef] | None = field(None)
    offers: list[Offer] = field([])
    contract: Offer | None = field(None)
    loaded: bool = field(False)
    time_left: float = field(0, unit="s")
    late: bool = field(False)
    damaged: bool = field(False)
    greased: bool = field(False)
    pad_lock: bool = field(False, doc="Just delivered here: the next load waits until the pilot leaves the pad or signs at the office.")

"""Per-entity data: chefs and the stations they work at."""

from enum import Enum

from parallax import ContentRef, Entity, component, field

from game.content import Item, StationKind


@component("chef")
class Chef:
    """A chef: what they carry and how far they reach."""

    held: ContentRef[Item] | None = field(None, doc="What the chef is carrying.")
    reach: float = field(3.2, unit="m", doc="How far away a station can be used from.")
    goal: Entity | None = field(None, doc="The nearest station that would move this chef's dish on (the guide).")
    said: str = field("", doc="The last feedback line in this chef's task banner.")
    said_bad: bool = field(False, doc="A burn or a wrong dish: the charcoal chip.")
    said_count: int = field(0, doc="Feedback lines so far (restarts the chip's animation).")
    said_at: float = field(-10, unit="s")


@component("station")
class Station:
    """Something chefs work at: a crate, a board, a stove, the window, a bin."""

    kind: ContentRef[StationKind] = field()


class PotState(Enum):
    EMPTY = "empty"
    COOKING = "cooking"
    READY = "ready"
    BURNT = "burnt"


@component("pot")
class Pot:
    """The pot on a stove. Cooks, holds, then burns if nobody collects it."""

    state: PotState = field(PotState.EMPTY)
    contents: ContentRef[Item] | None = field(None, doc="What it is cooking, or has cooked.")
    time_left: float = field(0, unit="s", doc="Until ready while cooking; until burnt once ready.")
    cook_seconds: float = field(0, unit="s")
    burn_seconds: float = field(0, unit="s")


@component("plate")
class Plate:
    """The plate on a plating station. Either chef can add to it or take it."""

    items: list[ContentRef[Item]] = field([])

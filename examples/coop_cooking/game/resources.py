"""Game-wide state: the service in progress (scores carry from kitchen to kitchen, the
streak and the rail start over in each), and the profile record."""

from enum import Enum

from parallax import ContentRef, Context, field, record, resource

from game.content import Dish


class Result(Enum):
    COOKING = "cooking"
    WON = "won"
    LOST = "lost"


@resource("service")
class Service:
    """The campaign run. The kitchen's clock is scene time (see rules.time_left)."""

    opened: bool = field(False, doc="The title's Open Kitchen was pressed; the clock runs from then.")
    kitchen: int = field(0, doc="Index into the campaign's kitchens.")
    scores: list[int] = field([0, 0], doc="Points per seat; the target is on their sum.")
    streak: int = field(0, keep="scene")
    best_streak: int = field(0)
    served: int = field(0)
    missed: int = field(0)
    burnt: int = field(0)
    binned: int = field(0)
    prep_actions: int = field(0, doc="Every station step a chef ran.")
    best_at_start: int = field(-1, doc="The device's best score when this campaign began (-1: not read yet).")
    missed_at: float = field(-10, unit="s", keep="scene", doc="When the last ticket expired (the rail's Missed! flash).")
    result: Result = field(Result.COOKING)


def cooking(ctx: Context) -> bool:
    """Run condition: the doors are open and the campaign is still on."""
    service = ctx.get(Service)
    return service.opened and service.result is Result.COOKING


@record
class Ticket:
    dish: ContentRef[Dish]
    number: int = field(0, doc="Printed on the ticket: #001.")
    time_left: float = field(unit="s")
    lifetime: float = field(unit="s")


@resource("orders", keep="scene")
class Orders:
    """Tickets on the rail, oldest first. A new kitchen starts with an empty rail."""

    tickets: list[Ticket] = field([])
    next_in: float = field(0, unit="s")
    printed: int = field(0, doc="Tickets printed in this kitchen (their numbers).")


@resource("record", keep="profile")
class Record:
    """The best this device has done, kept forever."""

    best_score: int = field(0)
    best_streak: int = field(0)
    kitchens_cleared: int = field(0)
    rounds_played: int = field(0)

"""Reading the recipe chain: what a chef can do at a station with what's in their hands.

Pure functions, shared by the chef's hands (to act), the chef card (to prompt) and
the playtests."""

import math
from enum import Enum

from parallax import Context, ContentRef, Entity, TextRef, field, record
from project import Text

from game.components import Chef, Plate, Pot, PotState, Station
from game.content import Item, Step


class Act(Enum):
    STEP = "step"           # run a recipe step
    TAKE_POT = "take_pot"   # lift a finished (or burnt) pot
    WAIT = "wait"           # the pot is still cooking


@record
class Plan:
    act: Act
    prompt: TextRef
    step: Step | None = field(None)
    seconds: int = field(0, doc="Cooking time left, for the WAIT prompt.")
    item: ContentRef[Item] | None = field(None, doc="What the pot holds, for the TAKE_POT prompt.")


def station_in_reach(ctx: Context, chef: Entity) -> Entity | None:
    """The nearest station within the chef's reach."""
    at = chef.transform.position
    nearest = ctx.world.query(Station).near(at, chef.get(Chef).reach).nearest(at)
    return None if nearest is None else nearest[0]


def plan(station: Entity, held: ContentRef[Item] | None) -> Plan | None:
    """What interacting with `station` would do, or None if nothing applies."""
    pot = station.try_get(Pot)
    if pot is not None and pot.state is not PotState.EMPTY:
        return pot_plan(pot, held)
    plate = station.try_get(Plate)
    on_plate = plate.items if plate is not None else []
    steps = [step for step in station.get(Station).kind.data.steps if accepts(step, held, on_plate)]
    if not steps:
        return None
    # The richest plate wins: tomato + lettuce + onion is a Deluxe, not a plain salad.
    best = max(steps, key=lambda step: len(step.requires_plate))
    return Plan(act=Act.STEP, prompt=best.prompt, step=best)


def pot_plan(pot: Pot, held: ContentRef[Item] | None) -> Plan | None:
    if held is not None:
        return None
    if pot.state is PotState.COOKING:
        return Plan(act=Act.WAIT, prompt=Text.cooking, seconds=math.ceil(pot.time_left))
    return Plan(act=Act.TAKE_POT, prompt=Text.take_pot if pot.state is PotState.READY else Text.clear_pot,
                item=pot.contents)


def accepts(step: Step, held: ContentRef[Item] | None, on_plate: list[ContentRef[Item]]) -> bool:
    if step.takes_anything:
        return held is not None
    if step.takes != held:
        return False
    if step.requires_plate:
        return all(item in on_plate for item in step.requires_plate)
    if step.to_plate:
        return held not in on_plate
    return True

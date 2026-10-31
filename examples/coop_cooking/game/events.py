"""Events: what the chefs did and what the kitchen did."""

from parallax import ContentRef, Entity, event

from game.content import Item


@event("dish_served")
class DishServed:
    by: Entity
    item: ContentRef[Item]


@event("food_binned")
class FoodBinned:
    by: Entity
    item: ContentRef[Item]


@event("step_done")
class StepDone:
    """A chef ran a station step (the results card's prep count)."""
    by: Entity


@event("pot_burnt")
class PotBurnt:
    stove: Entity

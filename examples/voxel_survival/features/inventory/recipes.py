"""Whether a recipe can be made right now, and where."""

from parallax import Context, Entity, TextRef, Vec3
from project import Text

from features.inventory.components import Equipment, Furnace, Inventory
from features.inventory.stacks import count_of
from game.components import Workbench
from game.config import Rules
from game.content import RecipeDef, Station


def idle_furnace(ctx: Context, near: Vec3) -> Entity | None:
    row = (ctx.world.query(Furnace)
           .near(near, ctx.config(Rules).station_range)
           .where(lambda _, furnace: furnace.output.count == 0)
           .nearest(near))
    return row[0] if row else None


def lock_reason(ctx: Context, recipe: RecipeDef, crafter: Entity) -> TextRef | None:
    """Why `crafter` can't make `recipe` now, or None if they can."""
    here = crafter.transform.position
    workbenches = ctx.world.query(tagged=Workbench).near(here, ctx.config(Rules).station_range)
    if recipe.station is Station.WORKBENCH and workbenches.count() == 0:
        return Text.needs_workbench
    if recipe.station is Station.FURNACE and idle_furnace(ctx, here) is None:
        return Text.needs_furnace
    slots = crafter.get(Inventory).slots
    if any(count_of(slots, need.item) < need.count for need in recipe.inputs):
        return Text.missing_ingredients
    tool = recipe.output.item
    if tool.data.tool and (count_of(slots, tool) > 0 or crafter.get(Equipment).tool == tool):
        return Text.already_owned
    return None

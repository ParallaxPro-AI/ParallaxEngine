"""The crafting, chest and furnace panels. Crafting toggles with its key; the chest
and furnace panels follow `OpenStation` (using one opens it, Close clears it)."""

from parallax import ContentRef, Context, Entity, Panel, close_panel, ui
from project import Content, Text

from features.inventory.actions import collect, craft, leave_station, store, take, use_slot
from features.inventory.components import Equipment, Furnace, Hotbar, Inventory
from features.inventory.recipes import lock_reason
from features.inventory.resources import OpenStation
from features.inventory.stacks import count_of
from game.actions import Controls
from game.content import ItemDef, RecipeDef, Stack, Station
from game.world import the_player


def picture(item: ContentRef[ItemDef] | None) -> str:
    """The item's pixel icon, drawn from the template's kit (assets/images/icons/<id>.svg)."""
    return f"../assets/images/icons/{item.id}.svg" if item is not None and item != Content.item.bare_hands else ""


def stack_view(ctx: Context, stack: Stack, slot: int, *, selected: bool = False, hotbar: int = 0,
               equipped: ContentRef[ItemDef] | None = None) -> dict:
    """One inventory slot as panel data; `slot` is the click payload."""
    item = stack.item.data if stack.item else None
    return {
        "slot": slot,
        "key": str(slot + 1) if slot < hotbar else "",
        "hotbar": slot < hotbar,
        "selected": selected,
        "equipped": stack.item is not None and stack.item == equipped,
        "count": stack.count,
        "count_label": str(stack.count) if stack.count > 1 else "",
        "name": ctx.text(item.name) if item else "",
        "picture": picture(stack.item) if stack.count else "",
    }


def backpack_view(ctx: Context, player: Entity) -> list[dict]:
    hotbar = player.get(Hotbar)
    tool = player.get(Equipment).tool
    return [stack_view(ctx, s, i, selected=i == hotbar.selected, hotbar=hotbar.size, equipped=tool)
            for i, s in enumerate(player.get(Inventory).slots)]


def recipe_view(ctx: Context, ref: ContentRef[RecipeDef], player: Entity) -> dict:
    """One recipe as panel data, with why it can't be made right now."""
    recipe = ref.data
    slots = player.get(Inventory).slots
    reason = lock_reason(ctx, recipe, player)
    inputs = []
    for need in recipe.inputs:
        have = count_of(slots, need.item)
        inputs.append({"name": ctx.text(need.item.data.name), "need": need.count, "have": have,
                       "enough": have >= need.count, "short": have < need.count})
    return {
        "recipe": ref.id,
        "label": ctx.text(recipe.name),
        "picture": picture(recipe.output.item),
        "count": recipe.output.count,
        "many": recipe.output.count > 1,
        "seconds": recipe.seconds,
        "inputs": inputs,
        "locked": reason is not None,
        "ready": reason is None,
        "reason": ctx.text(reason) if reason else "",
    }


def at_station(ctx: Context, kind: type) -> Entity | None:
    """The station in use, if it is still there and has a `kind` component."""
    station = ctx.get(OpenStation).station
    return station if station is not None and station.alive and station.has(kind) else None


@ui("crafting", html="ui/crafting.html", modal=True, toggle_with=Controls.craft)
class CraftingPanel(Panel):
    """The backpack and every recipe. Clicking a slot equips, selects or swaps it."""

    actions = {"craft": craft, "slot": use_slot, "close": close_panel()}

    def state(self, ctx):
        player = the_player(ctx)
        return {
            "equipment": ctx.text(Text.equipped, item=ctx.text(player.get(Equipment).tool.data.name)),
            "backpack": backpack_view(ctx, player),
            "recipes": [recipe_view(ctx, r, player) for r in ctx.content(RecipeDef)],
        }


@ui("chest", html="ui/chest.html", modal=True, when=lambda ctx: at_station(ctx, Inventory) is not None)
class ChestPanel(Panel):
    """A chest beside the backpack; clicking a stack moves it across."""

    actions = {"store": store, "take": take, "close": leave_station}

    def state(self, ctx):
        chest = at_station(ctx, Inventory).get(Inventory)
        return {
            "backpack": backpack_view(ctx, the_player(ctx)),
            "chest": [stack_view(ctx, s, i) for i, s in enumerate(chest.slots)],
        }


@ui("furnace", html="ui/furnace.html", modal=True, when=lambda ctx: at_station(ctx, Furnace) is not None)
class FurnacePanel(Panel):
    """What the furnace is smelting, its Collect button and the smelting recipes."""

    actions = {"craft": craft, "collect": collect, "close": leave_station}

    def state(self, ctx):
        player = the_player(ctx)
        furnace = at_station(ctx, Furnace).get(Furnace)
        output = furnace.output
        return {
            "output": f"{output.count} {ctx.text(output.item.data.name)}" if output.count else "",
            "seconds": round(furnace.seconds_left),
            "ready": output.count > 0 and furnace.seconds_left <= 0,
            "recipes": [recipe_view(ctx, r, player) for r in ctx.content(RecipeDef)
                        if r.data.station is Station.FURNACE],
        }

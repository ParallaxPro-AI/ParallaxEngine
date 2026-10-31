from parallax import Behavior, behavior

from features.inventory.feature import Equipment, Hotbar, Inventory
from game.actions import Controls


@behavior("hotbar_select", requires=[Hotbar, Inventory, Equipment])
class HotbarSelect(Behavior):
    """Number keys and the wheel pick a hotbar slot; picking a tool equips it.
    Next-tool cycles through every tool in the backpack."""

    def update(self, ctx, dt):
        hotbar = self.entity.get(Hotbar)
        slot = ctx.input.pressed_index(Controls.hotbar)
        if slot is not None:
            self._select(slot)
        scroll = ctx.input.value(Controls.scroll_hotbar)
        if scroll:
            self._select((hotbar.selected + (1 if scroll > 0 else -1)) % hotbar.size)
        if ctx.input.pressed(Controls.next_tool):
            self._next_tool()

    def _select(self, slot: int):
        self.entity.get(Hotbar).selected = slot
        item = self.entity.get(Inventory).slots[slot].item
        if item and item.data.tool:
            self.entity.get(Equipment).tool = item

    def _next_tool(self):
        equipment = self.entity.get(Equipment)
        tools = [s.item for s in self.entity.get(Inventory).slots if s.item and s.item.data.tool]
        if tools:
            after = tools.index(equipment.tool) + 1 if equipment.tool in tools else 0
            equipment.tool = tools[after % len(tools)]

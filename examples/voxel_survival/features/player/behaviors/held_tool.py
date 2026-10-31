from parallax import Behavior, behavior, param, state
from parallax.viewmodel import Viewmodel

from features.inventory.feature import Equipment
from game.actions import Controls


@behavior("held_tool", requires=[Equipment])
class HeldTool(Behavior):
    """The equipped tool in first person, as the template's procedural viewmodel showed
    it: the item's `view` prefab in the camera's hands (bare hands hold nothing), swung
    while mine is held."""

    swing_every: float = param(0.42, unit="s", doc="One swing per this while mining or attacking.")
    next_swing: float = state(0.0)

    def update(self, ctx, dt):
        hands = ctx.camera.main.entity.child("hands").get(Viewmodel)
        view = self.entity.get(Equipment).tool.data.view
        if hands.item != view:
            hands.item = view
        if view is not None and ctx.input.held(Controls.mine) and ctx.time.now >= self.next_swing:
            self.next_swing = ctx.time.now + self.swing_every
            hands.play("swing")

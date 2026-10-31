"""The arming hotkeys."""

from parallax import System, system
from project import Scenes

from game.actions import GardenControls
from game.arming import arm_seed, arm_trowel, arm_watering_can, disarm
from game.lawn import current_level
from game.resources import Planting


@system("tools", scenes=[Scenes.garden])
class Tools(System):
    """Number keys pick a seed from the tray and the shoulders cycle it; W, 7 and C arm
    the watering can, arm the trowel and disarm. The HUD's buttons call the same
    functions (arming.py)."""

    def update(self, ctx, dt):
        tray = current_level(ctx).cards
        slot = ctx.input.pressed_index(GardenControls.seed)
        if slot is not None and slot < len(tray):
            arm_seed(ctx, tray[slot])
            ctx.get(Planting).cursor_active = True  # as the template: a hotkey hands the cell to the keys
        step = int(ctx.input.pressed(GardenControls.next_seed)) - int(ctx.input.pressed(GardenControls.previous_seed))
        if step:
            ctx.get(Planting).cursor_active = True
            seed = ctx.get(Planting).seed
            index = tray.index(seed) + step if seed in tray else 0
            arm_seed(ctx, tray[index % len(tray)])
        if ctx.input.pressed(GardenControls.water):
            arm_watering_can(ctx)
        if ctx.input.pressed(GardenControls.dig):
            arm_trowel(ctx)
        if ctx.input.pressed(GardenControls.cancel):
            disarm(ctx)

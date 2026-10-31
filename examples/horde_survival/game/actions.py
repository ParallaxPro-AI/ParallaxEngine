"""The staff fires itself: the player only steers, dashes and calls the Ember Nova.
These controls exist only in the arena (no touch sticks or pause key on the title), and
go quiet once the run is decided, so P can't stack the pause menu over the end screen.

On touch, the Nova is the one primary button: greyed with a recharge sweep while it cools,
like the template's. Dash greys out while its charge is back in the bellows."""

from parallax import Actions, Color, Context, TouchSkin, axis2, button, gamepad, keys, touch
from project import Scenes

from game.components import Build
from game.rules import run_live, survivor


def nova_recharge(ctx: Context) -> float:
    """0..1 of the Nova's cooldown still to go."""
    build = survivor(ctx).get(Build)
    return max(0.0, build.nova_ready_at - ctx.time.now) / build.nova_cooldown


def dash_recharge(ctx: Context) -> float:
    build = survivor(ctx).get(Build)
    return max(0.0, build.dash_ready_at - ctx.time.now) / build.dash_cooldown


class Controls(Actions):
    scenes = [Scenes.arena]
    touch_skin = TouchSkin(
        fill=Color.hex("#170a0699"), stroke=Color.hex("#fdba7459"), ink=Color.hex("#f6e9df"),
        pressed=Color.hex("#3c180acc"), accent=Color.hex("#ea580c"), shape="circle",
        font="Inter, system-ui, sans-serif",
    )

    move = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    nova = button(keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button(
        "touch_nova", icon="bomb", zone="primary",
        enabled_when=lambda ctx: nova_recharge(ctx) == 0, cooldown=nova_recharge))
    dash = button(keyboard="ShiftLeft", gamepad=gamepad.EAST, touch=touch.button(
        "touch_dash", icon="chevrons_right", zone="actions",
        enabled_when=lambda ctx: dash_recharge(ctx) == 0))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

    @staticmethod
    def active_when(ctx, owner):
        return run_live(ctx)

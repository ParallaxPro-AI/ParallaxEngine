"""Input. The touch controls wear the template's enamel / ticket skin (cream plates, dark
ink, a mustard ring, Nunito Sans) and its Interact button greys out while pressing it
would do nothing there (no station in reach, or a pot still cooking), as the template's
`visibility: {when: chef_prompt_p1.act, mode: disable}` did. Touch drives the first seat
only; the HUD's pause plate pauses on touch."""

from parallax import Actions, Color, Context, TouchSkin, axis2, button, gamepad, keys, touch

from game.components import Chef
from game.recipes import Act, plan, station_in_reach
from game.resources import Service


def can_interact(ctx: Context) -> bool:
    """Would the first chef's Interact do something right now?"""
    chef = ctx.players[0].entity if ctx.players else None
    if chef is None:
        return False
    station = station_in_reach(ctx, chef)
    action = plan(station, chef.get(Chef).held) if station is not None else None
    return action is not None and action.act is not Act.WAIT


class ChefControls(Actions):
    """What a chef can do. The first seat plays on the left of the keyboard. Live once
    the title's Open Kitchen is pressed (no pause over the title)."""

    touch_skin = TouchSkin(
        fill=Color.hex("#fff7ed"),
        stroke=Color.hex("#facc15"),
        ink=Color.hex("#1f1712"),
        pressed=Color.hex("#f4e4cd"),
        accent=Color.hex("#fff7ed"),
        shape="circle",
        font="'Nunito Sans', system-ui, sans-serif",
    )
    move = axis2(keyboard=keys.WASD, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    interact = button(keyboard="KeyE", gamepad=gamepad.SOUTH,
                      touch=touch.button("Interact", icon="hand", enabled_when=can_interact))
    pause = button(keyboard="KeyP", gamepad=gamepad.START, touch=touch.NONE)

    @staticmethod
    def active_when(ctx, owner):
        return ctx.get(Service).opened


class SecondChefControls(ChefControls):
    """The same actions for the second seat, on the right of the keyboard.
    Behaviors read `ChefControls.move`; the seat decides which bindings answer."""

    move = axis2(keyboard=keys.composite(up="KeyI", left="KeyJ", down="KeyK", right="KeyL"),
                 gamepad=gamepad.LEFT_STICK)
    interact = button(keyboard="KeyO", gamepad=gamepad.SOUTH)

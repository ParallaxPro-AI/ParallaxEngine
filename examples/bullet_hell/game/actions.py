"""Input, live only in the garden. The Wisp drifts in every direction; Focus slows it
for threading gaps."""

from parallax import Actions, Color, TouchSkin, axis2, button, gamepad, keys, touch
from project import Scenes


class Controls(Actions):
    scenes = [Scenes.garden]
    # The template's moonlit touch skin: translucent teal circles, sage outline, mint ink,
    # the leaf accent while pressed (game.json platforms.controls.skin).
    touch_skin = TouchSkin(fill=Color.hex("#12382e").with_alpha(0.55), stroke=Color.hex("#91b69f").with_alpha(0.65),
                           ink=Color.hex("#effff5"), pressed=Color.hex("#d7f3b8"), accent=Color.hex("#d7f3b8"),
                           shape="circle", font="Quicksand, ui-rounded, system-ui, sans-serif")
    move = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    focus = button(keyboard="KeyC", gamepad=gamepad.RIGHT_SHOULDER, touch=touch.button("Focus"))
    bomb = button(keyboard="KeyX", gamepad=gamepad.EAST, touch=touch.button("Bloom", icon="flower"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

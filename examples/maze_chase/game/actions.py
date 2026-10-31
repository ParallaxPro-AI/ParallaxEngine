"""Input, live only in the maze. Touch steers with a d-pad or a swipe anywhere: one
cardinal direction at a time, which is what a maze wants (a stick presses diagonals).
The touch controls wear the template's Neon Warren skin: indigo plates, a neon-cyan
stroke and ink, gold when pressed."""

from parallax import Actions, Color, TouchSkin, axis2, button, gamepad, keys, touch
from project import Scenes


class Controls(Actions):
    scenes = [Scenes.maze]
    touch_skin = TouchSkin(
        fill=Color.hex("#141038db"),
        stroke=Color.hex("#7fdcff"),
        ink=Color.hex("#7fdcff"),
        pressed=Color.hex("#ffd24a38"),
        accent=Color.hex("#ffd24a"),
        shape="rounded",
    )
    move = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.DPAD | gamepad.LEFT_STICK,
                 touch=touch.dpad() | touch.swipe())
    pause = button(keyboard="KeyP", gamepad=gamepad.START, touch=touch.NONE)

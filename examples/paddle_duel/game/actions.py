"""Input, live only in the arena. One thumb steers, the other holds Smash: charging
while moving is the decision every rally asks for. Perk cards carry their own 1/2/3
keys (ui/draft.html)."""

from parallax import Actions, axis1, button, gamepad, touch
from project import Scenes


class Controls(Actions):
    scenes = [Scenes.arena]
    move = axis1(negative=("KeyS", "ArrowDown"), positive=("KeyW", "ArrowUp"),
                 gamepad=gamepad.LEFT_STICK_Y, touch=touch.joystick("left"))
    smash = button(keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button("Smash", icon="zap"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

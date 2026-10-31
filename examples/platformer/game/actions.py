"""Run, jump, dash, pause."""

from parallax import Actions, axis1, button, gamepad, touch

from game.components import Level
from game.resources import playing


class Controls(Actions):
    # A side-scroller: run left and right along the lane (a stick's x on gamepad and touch).
    run = axis1(negative=("KeyA", "ArrowLeft"), positive=("KeyD", "ArrowRight"),
                gamepad=gamepad.LEFT_STICK_X, touch=touch.joystick("left"))
    jump = button(keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button("Jump"))
    dash = button(keyboard=("ShiftLeft", "KeyX"), gamepad=gamepad.WEST, touch=touch.button("Dash"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

    # The hub is all menus.
    scenes = [Level]

    @staticmethod
    def active_when(ctx, owner):
        """Live until the level is cleared or failed."""
        return playing(ctx)

"""Swipe-runner controls: change lane, jump, slide. Plus pause."""

from parallax import Actions, button, gamepad, touch
from project import Scenes

from game.resources import running


class Controls(Actions):
    left = button(keyboard=("KeyA", "ArrowLeft"), gamepad=gamepad.DPAD_LEFT | gamepad.LEFT_SHOULDER, touch=touch.swipe("left"))
    right = button(keyboard=("KeyD", "ArrowRight"), gamepad=gamepad.DPAD_RIGHT | gamepad.RIGHT_SHOULDER, touch=touch.swipe("right"))
    jump = button(keyboard=("Space", "KeyW", "ArrowUp"), gamepad=gamepad.SOUTH, touch=touch.swipe("up"))
    # On the ground: a slide. In the air: a fast-fall that lands in a slide.
    slide = button(keyboard=("KeyS", "ArrowDown"), gamepad=gamepad.EAST, touch=touch.swipe("down"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

    # Nothing on the title runs or pauses.
    scenes = [Scenes.street]

    @staticmethod
    def active_when(ctx, owner):
        """A finished run waits for its end card."""
        return running(ctx)

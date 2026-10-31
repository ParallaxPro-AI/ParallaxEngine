"""Input, live only in the arena. The paddle also follows the mouse or a finger dragged
across the board (see `PaddleControl`). Upgrade cards carry their own 1/2/3 keys
(ui/draft.html)."""

from parallax import Actions, axis1, button, gamepad, touch
from project import Scenes

from game.resources import Run


class Controls(Actions):
    scenes = [Scenes.arena]
    steer = axis1(negative=("KeyA", "ArrowLeft"), positive=("KeyD", "ArrowRight"),
                  gamepad=gamepad.LEFT_STICK_X)
    steer_left = button(touch=touch.button("Left", icon="arrowLeft"))
    steer_right = button(touch=touch.button("Right", icon="arrowRight"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)


class ServeControls(Actions):
    """Live only while the orb rests on the paddle, so the touch Launch button shows
    only then."""
    scenes = [Scenes.arena]
    launch = button(keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button("Launch", icon="target"))

    @staticmethod
    def active_when(ctx, owner):
        return ctx.get(Run).serving

"""Twin-stick controls: move with one stick, shoot with the other. They exist only in the
cellar (so the title has no touch sticks and no pause key), and go quiet once the run is
decided, so P can't stack the pause menu over the end-of-run screen. While the boss
intro plays the keeper holds still and P skips the cutscene instead."""

from parallax import Actions, axis2, button, gamepad, keys, touch
from project import Scenes

from game.resources import Run


class Controls(Actions):
    scenes = [Scenes.cellar]

    move = axis2(keyboard=keys.WASD, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    shoot = axis2(keyboard=keys.ARROWS, gamepad=gamepad.RIGHT_STICK, touch=touch.joystick("right"))
    bomb = button(keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button("touch_bomb", icon="bomb"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

    @staticmethod
    def active_when(ctx, owner):
        return ctx.get(Run).outcome is None and not ctx.cinematics.playing


class CutsceneControls(Actions):
    """Only while a cutscene (the boss intro) plays: P or Start skips it."""
    scenes = [Scenes.cellar]

    skip = button(keyboard="KeyP", gamepad=gamepad.START)

    @staticmethod
    def active_when(ctx, owner):
        return ctx.cinematics.playing

"""The menu controls. Each feature declares its own action set next to the code that reads it."""

from parallax import Actions, button, gamepad
from project import Scenes


class MenuControls(Actions):
    """Pausing (P, as in the template). Scoped to the realm, so it does nothing on the title screen."""

    pause = button(keyboard="KeyP", gamepad=gamepad.START)

    scenes = [Scenes.sundermere]

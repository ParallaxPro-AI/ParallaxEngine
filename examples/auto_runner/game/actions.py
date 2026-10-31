"""Two verbs, one per thumb: hop and duck. Plus pause."""

from parallax import Actions, button, gamepad, touch
from project import Scenes

from game.resources import running


class Controls(Actions):
    hop = button(
        keyboard=("Space", "ArrowUp"),
        gamepad=gamepad.SOUTH,
        touch=touch.button("Hop", icon="chevrons_up") | touch.swipe("up"),
    )
    # Held: a slide on the ground, a fast-fall in the air. No swipe: a swipe is
    # momentary and duck is a sustained state.
    duck = button(keyboard=("ArrowDown", "KeyS"), gamepad=gamepad.EAST, touch=touch.button("Duck", icon="chevrons_down"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

    # The title has nothing to hop or pause (and no touch buttons for it).
    scenes = [Scenes.canyon]

    @staticmethod
    def active_when(ctx, owner):
        """A finished run waits for its end card."""
        return running(ctx)

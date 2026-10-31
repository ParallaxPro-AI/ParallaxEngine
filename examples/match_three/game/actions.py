from parallax import Actions, button, gamepad, mouse, touch
from project import Scenes


class Controls(Actions):
    """The board is the controller: tap a gem, then tap a neighbour to swap them.
    Where the tap landed is read from `ctx.input.pointer`."""
    scenes = [Scenes.board]
    select = button(mouse=mouse.LEFT, touch=touch.TAP)
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

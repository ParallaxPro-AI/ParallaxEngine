from parallax import Actions, axis2, button, gamepad, mouse
from project import Scenes


class Controls(Actions):
    """The whole alphabet is the controller and arrives as text (`ctx.input.text`),
    so the only action is pause, on a key no word uses (0)."""
    scenes = [Scenes.grid]
    pause = button(keyboard="Digit0", gamepad=gamepad.START)


class BoardControls(Actions):
    """Hold the right mouse button and drag to swing the board camera around the grid. Only
    on the grid: read anywhere else, the mouse delta would make the title a mouse-look scene
    (no cursor) instead of a menu with the cursor free."""
    scenes = [Scenes.grid]
    orbit = button(mouse=mouse.RIGHT)
    look = axis2(mouse=mouse.DELTA)

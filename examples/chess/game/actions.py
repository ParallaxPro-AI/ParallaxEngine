from parallax import Actions, button, gamepad


class Controls(Actions):
    """Moves are taps on the board (`ctx.input.pointer`); the only action is pause."""
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

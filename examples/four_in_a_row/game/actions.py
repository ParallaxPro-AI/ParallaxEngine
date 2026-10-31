from parallax import Actions, button, gamepad


class Controls(Actions):
    """Drops are taps on the well (`ctx.input.pointer`); the only action is pause."""
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

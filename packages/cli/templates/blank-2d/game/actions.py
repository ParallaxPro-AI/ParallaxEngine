"""Input. Code reads actions, never raw keys, so players can remap them and touch
controls are generated from these declarations."""

from parallax import Actions, axis2, gamepad, keys, touch


class Controls(Actions):
    """WASD or the arrow keys, the left stick, or an on-screen joystick."""
    move = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))

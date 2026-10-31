"""Input. Code reads actions, never raw keys, so players can remap them and touch
controls are generated from these declarations."""

from parallax import Actions, axis1, gamepad, touch


class Controls(Actions):
    """A/D or the arrow keys, the left stick, or an on-screen joystick."""
    move = axis1(negative=("KeyA", "ArrowLeft"), positive=("KeyD", "ArrowRight"),
                 gamepad=gamepad.LEFT_STICK_X, touch=touch.joystick("left"))

from parallax import Actions, axis2, button, gamepad, keys, touch


class Controls(Actions):
    """No mouse-look: the cursor stays free for the HUD, and the same four-way
    aim works as a touch d-pad."""
    aim = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    throw = button(keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button("Throw"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

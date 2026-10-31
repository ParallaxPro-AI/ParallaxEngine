from parallax import Actions, axis2, button, gamepad, keys, touch


class Controls(Actions):
    """One player, whichever home outfielder they currently control."""

    move = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    sprint = button(keyboard="ShiftLeft", gamepad=gamepad.RIGHT_TRIGGER, touch=touch.button("Sprint"))
    shoot = button(keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button("Shoot"))
    pass_ball = button(keyboard="KeyQ", gamepad=gamepad.EAST, touch=touch.button("Pass"))
    switch = button(keyboard="KeyE", gamepad=gamepad.LEFT_SHOULDER, touch=touch.button("Switch"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

from parallax import Actions, axis2, button, gamepad, keys, touch


class Controls(Actions):
    move = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    sprint = button(keyboard="ShiftLeft", gamepad=gamepad.RIGHT_TRIGGER, touch=touch.button("Sprint"))
    shoot = button(keyboard="Space", gamepad=gamepad.WEST, touch=touch.button("Shoot"))
    pass_ball = button(keyboard="KeyF", gamepad=gamepad.SOUTH, touch=touch.button("Pass"))
    steal = button(keyboard="KeyE", gamepad=gamepad.EAST, touch=touch.button("Steal"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

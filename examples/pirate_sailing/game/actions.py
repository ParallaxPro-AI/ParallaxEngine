"""The helm. Touch labels are locale keys."""

from parallax import Actions, axis1, button, gamepad, mouse, touch


class Helm(Actions):
    sail = axis1(negative=("KeyS", "ArrowDown"), positive=("KeyW", "ArrowUp"),
                 gamepad=gamepad.LEFT_STICK_Y, touch=touch.joystick("left"))
    rudder = axis1(negative=("KeyA", "ArrowLeft"), positive=("KeyD", "ArrowRight"),
                   gamepad=gamepad.RIGHT_STICK_X, touch=touch.joystick("right"))
    anchor = button(keyboard="Space", gamepad=gamepad.NORTH, touch=touch.button("anchor", icon="anchor"))
    fire_port = button(mouse=mouse.LEFT, gamepad=gamepad.LEFT_TRIGGER,
                       touch=touch.button("port", icon="cannon_left"))
    fire_starboard = button(mouse=mouse.RIGHT, gamepad=gamepad.RIGHT_TRIGGER,
                            touch=touch.button("starboard", icon="cannon_right"))
    contract = button(keyboard="KeyQ", gamepad=gamepad.WEST, touch=touch.button("contract", icon="map"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

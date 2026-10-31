"""Player intent. Mouse-look orbits the chase camera, and the turret follows it."""

from parallax import Actions, axis1, axis2, button, gamepad, keys, mouse, touch

from game.components import BattlefieldScene


class TankControls(Actions):
    scenes = [BattlefieldScene]

    drive = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    """y = throttle, x = steer."""
    brake = button(keyboard="Space", gamepad=gamepad.LEFT_TRIGGER)
    look = axis2(mouse=mouse.DELTA, gamepad=gamepad.RIGHT_STICK, touch=touch.LOOK)
    traverse = axis1(negative="KeyQ", positive="KeyE", gamepad=gamepad.LEFT_SHOULDER | gamepad.RIGHT_SHOULDER)
    fire = button(mouse=mouse.LEFT, gamepad=gamepad.RIGHT_TRIGGER, touch=touch.button("Fire"))
    repair = button(keyboard="KeyR", gamepad=gamepad.NORTH, touch=touch.button("Repair"))
    lock = button(keyboard="KeyF", touch=touch.button("Lock"))
    """Lock the enemy hull nearest the crosshair, or let go."""
    cycle_prev = button(keyboard="KeyZ")
    cycle_next = button(keyboard="KeyX")
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

"""Behind the wheel."""

from parallax import Actions, axis1, button, gamepad, touch
from features.on_foot.feature import in_a_car
from features.phone.feature import PhotoMode


class DrivingControls(Actions):
    """Live while the player is in a car and not looking through the phone's camera. E exits here and
    enters on foot: the two sets are never live together, so they never conflict."""

    throttle = axis1(negative="KeyS", positive="KeyW", gamepad=gamepad.RIGHT_TRIGGER, touch=touch.joystick("left"))
    steer = axis1(negative="KeyA", positive="KeyD", gamepad=gamepad.LEFT_STICK_X, touch=touch.joystick("left"))
    brake = button(keyboard="KeyX", gamepad=gamepad.LEFT_TRIGGER, touch=touch.button("Stop", icon="square"))
    handbrake = button(keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button("Drift", icon="wind"))
    exit = button(keyboard="KeyE", gamepad=gamepad.NORTH, touch=touch.button("Exit", icon="door"))

    active_when = lambda ctx, owner: in_a_car(ctx, owner) and not ctx.get(PhotoMode).active

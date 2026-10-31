"""Driving controls. Touch labels are locale keys."""

from parallax import Actions, axis1, button, gamepad, touch

from game.components import TrackScene


class DriveControls(Actions):
    """Exist on track scenes only, so the pause key does nothing in the garage. Throttle
    is one axis on every device: the opposite direction brakes while rolling."""

    scenes = [TrackScene]

    steer = axis1(negative=("KeyA", "ArrowLeft"), positive=("KeyD", "ArrowRight"),
                  gamepad=gamepad.LEFT_STICK_X, touch=touch.joystick("left"))
    throttle = axis1(negative=("KeyS", "ArrowDown"), positive=("KeyW", "ArrowUp"),
                     gamepad=gamepad.LEFT_TRIGGER | gamepad.RIGHT_TRIGGER,
                     touch=touch.button("brake", icon="chevrons_down") | touch.button("gas", icon="chevrons_up"))
    drift = button(keyboard="Space", gamepad=gamepad.EAST, touch=touch.button("drift", icon="zap"))
    nitro = button(keyboard="ShiftLeft", gamepad=gamepad.SOUTH, touch=touch.button("nitro", icon="flame"))
    respawn = button(keyboard="KeyE", gamepad=gamepad.NORTH, touch=touch.button("respawn", icon="refresh"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)


class IntroControls(Actions):
    """Only while the pre-race flyby plays: Enter or Back skips it (the lights keep counting)."""
    scenes = [TrackScene]

    skip = button(keyboard="Enter", gamepad=gamepad.SELECT)

    @staticmethod
    def active_when(ctx, owner):
        return ctx.cinematics.playing

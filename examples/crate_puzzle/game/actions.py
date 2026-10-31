from parallax import Actions, button, gamepad, touch
from project import Scenes

HOLD = (0.16, 0.085)
"""Held directions step again after 0.16 s, then every 0.085 s."""


class Controls(Actions):
    """Step one cell per press (held, the step repeats); undo, redo and reset take
    back mistakes. The touch d-pad is discrete on purpose: a curved thumb must never
    step twice."""
    scenes = [Scenes.yard]
    up = button(keyboard=("ArrowUp", "KeyW"), gamepad=gamepad.DPAD_UP, touch=touch.dpad("up"), repeat=HOLD)
    down = button(keyboard=("ArrowDown", "KeyS"), gamepad=gamepad.DPAD_DOWN, touch=touch.dpad("down"), repeat=HOLD)
    left = button(keyboard=("ArrowLeft", "KeyA"), gamepad=gamepad.DPAD_LEFT, touch=touch.dpad("left"), repeat=HOLD)
    right = button(keyboard=("ArrowRight", "KeyD"), gamepad=gamepad.DPAD_RIGHT, touch=touch.dpad("right"), repeat=HOLD)
    undo = button(keyboard="KeyZ", gamepad=gamepad.WEST, touch=touch.button("Undo", icon="undo"))
    redo = button(keyboard="KeyY", gamepad=gamepad.NORTH, touch=touch.button("Redo", icon="redo"))
    reset = button(keyboard="KeyR", gamepad=gamepad.SELECT, touch=touch.button("Reset", icon="refresh"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

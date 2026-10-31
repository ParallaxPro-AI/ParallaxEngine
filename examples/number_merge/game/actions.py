from parallax import Actions, button, gamepad, touch
from project import Scenes


class Controls(Actions):
    """Slide the whole board with the arrows, WASD, the d-pad or a swipe."""
    scenes = [Scenes.board]
    up = button(keyboard=("ArrowUp", "KeyW"), gamepad=gamepad.DPAD_UP, touch=touch.swipe("up"))
    down = button(keyboard=("ArrowDown", "KeyS"), gamepad=gamepad.DPAD_DOWN, touch=touch.swipe("down"))
    left = button(keyboard=("ArrowLeft", "KeyA"), gamepad=gamepad.DPAD_LEFT, touch=touch.swipe("left"))
    right = button(keyboard=("ArrowRight", "KeyD"), gamepad=gamepad.DPAD_RIGHT, touch=touch.swipe("right"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START, touch=touch.button("pause", icon="pause"))

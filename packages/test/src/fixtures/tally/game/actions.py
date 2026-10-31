from parallax import Actions, axis1, axis2, button, button_group, keys
from project import Scenes


class Controls(Actions):
    scenes = [Scenes.arena]
    bump = button(keyboard="Space")
    pause = button(keyboard="KeyP")
    steer = axis2(keyboard=keys.WASD)
    throttle = axis1(negative="KeyQ", positive="KeyE")
    lanes = button_group(keyboard=("Digit1", "Digit2", "Digit3"))

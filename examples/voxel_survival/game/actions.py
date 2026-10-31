"""Every input the game reads. Touch controls are generated from these."""

from parallax import Actions, axis1, axis2, button, button_group, gamepad, keys, mouse, touch
from project import Scenes


class Controls(Actions):
    scenes = [Scenes.greenwood]
    """Only the world reads input, so the title screen never locks the pointer."""

    move = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    look = axis2(mouse=mouse.DELTA, gamepad=gamepad.RIGHT_STICK, touch=touch.LOOK)
    """Turns the first-person camera rig (and with it the body)."""
    jump = button(keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button("Jump", icon="chevrons_up"))
    """Jumps on land; held in water, swims up."""
    sprint = button(keyboard="ShiftLeft", gamepad=gamepad.LEFT_SHOULDER)
    mine = button(mouse=mouse.LEFT, gamepad=gamepad.RIGHT_TRIGGER, touch=touch.button("Mine", icon="target"))
    place = button(mouse=mouse.RIGHT, gamepad=gamepad.LEFT_TRIGGER, touch=touch.button("Place", icon="square"))
    use = button(keyboard="KeyE", gamepad=gamepad.WEST, touch=touch.button("Use", icon="hand"))
    eat = button(keyboard="KeyF", gamepad=gamepad.NORTH, touch=touch.button("Eat", icon="heart"))
    craft = button(keyboard="KeyC", gamepad=gamepad.SELECT, touch=touch.button("Craft", icon="box"))
    next_tool = button(keyboard="KeyQ", gamepad=gamepad.EAST)
    scroll_hotbar = axis1(mouse=mouse.WHEEL)
    hotbar = button_group(keyboard=("Digit1", "Digit2", "Digit3", "Digit4", "Digit5",
                                    "Digit6", "Digit7", "Digit8", "Digit9"))
    """Picks a hotbar slot directly."""
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

"""Player intent. The pointer picks cells directly; the cursor is the keyboard/gamepad
way, one cell per flick and repeating while held."""

from parallax import Actions, Color, TouchSkin, axis2, button, button_group, gamepad, keys, mouse, touch
from project import Scenes


class GardenControls(Actions):
    scenes = [Scenes.garden]
    touch_skin = TouchSkin(  # the template's platforms.controls.skin
        fill=Color.hex("#fcf4d9"), ink=Color.hex("#183d2e"), stroke=Color.hex("#e7d8ac"),
        pressed=Color.hex("#edb74b"), accent=Color.hex("#edb74b"), shape="circle",
        font="'Grandstander', 'Nunito', 'Trebuchet MS', sans-serif",
    )

    confirm = button(keyboard="Enter", mouse=mouse.LEFT, gamepad=gamepad.SOUTH, touch=touch.TAP)
    cancel = button(keyboard="KeyC", mouse=mouse.RIGHT, gamepad=gamepad.EAST)
    cursor = axis2(keyboard=keys.ARROWS, gamepad=gamepad.DPAD | gamepad.LEFT_STICK,
                   repeat=(0.16, 0.16))
    water = button(keyboard="KeyW", gamepad=gamepad.WEST)
    dig = button(keyboard="Digit7", gamepad=gamepad.NORTH)
    seed = button_group(keyboard=("Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6"))
    """Seed hotkeys, in tray order."""
    next_seed = button(gamepad=gamepad.RIGHT_SHOULDER)
    previous_seed = button(gamepad=gamepad.LEFT_SHOULDER)
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

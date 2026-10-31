"""Player intent. Pads are picked with the pointer, or cycled with the shoulders. The
palette's number keys live on the palette cards (`data-key` in ui/hud.html)."""

from parallax import Actions, axis2, button, gamepad, keys, mouse, touch

from game.components import BattlefieldScene


class SiegeControls(Actions):
    scenes = [BattlefieldScene]

    select = button(mouse=mouse.LEFT, touch=touch.TAP, gamepad=gamepad.SOUTH)
    cancel = button(keyboard="KeyC", mouse=mouse.RIGHT, gamepad=gamepad.EAST)
    next_pad = button(gamepad=gamepad.RIGHT_SHOULDER)
    previous_pad = button(gamepad=gamepad.LEFT_SHOULDER)
    upgrade = button(keyboard="KeyU", gamepad=gamepad.NORTH)
    sell = button(keyboard="KeyX", gamepad=gamepad.WEST)
    send_wave = button(keyboard="Space", gamepad=gamepad.RIGHT_TRIGGER, touch=touch.button("Send wave"))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)
    pan = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.LEFT_STICK)
    recenter = button(keyboard="Home", gamepad=gamepad.SELECT)

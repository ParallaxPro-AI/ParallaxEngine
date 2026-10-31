"""Player intent. The mouse-look binding makes the engine lock the pointer during play."""

from parallax import Actions, Color, TouchSkin, axis1, axis2, button, button_group, gamepad, keys, mouse, touch
from project import Scenes


class FpsControls(Actions):
    scenes = [Scenes.arena]
    touch_preset = "fps"
    # The template's touch skin (game.json platforms.controls.skin): teal-black fills, brass
    # ink and edges, a pale-brass press, square (the nearest to its chamfer) in Barlow.
    touch_skin = TouchSkin(
        fill=Color(10 / 255, 23 / 255, 27 / 255, 0.86),
        stroke=Color(230 / 255, 186 / 255, 112 / 255, 0.55),
        ink=Color.hex("#e6ba70"),
        pressed=Color.hex("#f8d899"),
        accent=Color(10 / 255, 23 / 255, 27 / 255, 0.9),
        shape="square",
        font="'Barlow Condensed', 'Arial Narrow', sans-serif",
    )

    move = axis2(keyboard=keys.WASD, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    look = axis2(mouse=mouse.DELTA, gamepad=gamepad.RIGHT_STICK, touch=touch.LOOK)
    jump = button(keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button("Jump", icon="chevrons_up"))
    sprint = button(keyboard="ShiftLeft", gamepad=gamepad.LEFT_SHOULDER)
    fire = button(mouse=mouse.LEFT, gamepad=gamepad.RIGHT_TRIGGER, touch=touch.button("Fire", icon="target"))
    zoom = button(mouse=mouse.RIGHT, gamepad=gamepad.LEFT_TRIGGER, touch=touch.button("Aim", icon="eye"))
    reload = button(keyboard="KeyR", gamepad=gamepad.WEST, touch=touch.button("Reload", icon="rotate_cw"))
    switch_weapon = axis1(mouse=mouse.WHEEL, gamepad=gamepad.DPAD_LEFT | gamepad.DPAD_RIGHT)
    crouch = button(keyboard="KeyC", gamepad=gamepad.EAST, touch=touch.button("Crouch", icon="chevrons_down"))
    interact = button(keyboard="KeyE", gamepad=gamepad.NORTH)
    weapon_slot = button_group(
        keyboard=("Digit1", "Digit2", "Digit3", "Digit4"),
        # PROPOSED: None leaves a slot unbound on that device (NOTES.md). Only the
        # grenades have gamepad shortcuts.
        gamepad=(None, None, gamepad.DPAD_UP, gamepad.RIGHT_SHOULDER),
        touch_labels=("Rifle", "Sniper", "Smoke", "Frag"),
    )
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

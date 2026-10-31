"""Every input the game reads. On the server, a hero's behaviors read its owner's."""

from parallax import Actions, Color, TouchSkin, button, gamepad, mouse, touch
from project import Scenes


class Controls(Actions):
    scenes = [Scenes.arena]
    touch_skin = TouchSkin(
        fill=Color.hex("#1b2a47"), stroke=Color.hex("#94aed640"), ink=Color.hex("#eef3fa"),
        pressed=Color.hex("#2a3f66"), accent=Color.hex("#338cf2"), shape="circle",
        font="Rajdhani, 'Arial Narrow', sans-serif",
    )
    """The template's touch skin (game.json platforms.controls.skin): navy plates lit from
    #2a3f66, the Azure accent, Rajdhani caps, round buttons."""

    order = button(mouse=mouse.RIGHT, touch=touch.TAP)
    """Move to the pointer, or attack what's under it."""
    ability_q = button(keyboard="KeyQ", gamepad=gamepad.WEST, touch=touch.button("Q"))
    ability_w = button(keyboard="KeyW", gamepad=gamepad.NORTH, touch=touch.button("W"))
    ability_e = button(keyboard="KeyE", gamepad=gamepad.EAST, touch=touch.button("E"))
    ability_r = button(keyboard="KeyR", gamepad=gamepad.RIGHT_SHOULDER, touch=touch.button("R"))
    rank_up = button(keyboard="ControlLeft", gamepad=gamepad.LEFT_SHOULDER)
    """Held with an ability key: spend a skill point on that ability."""
    ward = button(keyboard="KeyT", gamepad=gamepad.DPAD_UP, touch=touch.button("Ward", icon="eye"))
    """Place a Picket ward at the pointer."""
    watchfire = button(keyboard="Digit5", gamepad=gamepad.DPAD_RIGHT, touch=touch.button("Fire", icon="flame"))
    """Plant a Watchfire at the pointer: permanent, seen by all, sees into brush."""
    hushbell = button(keyboard="Digit6", gamepad=gamepad.DPAD_DOWN, touch=touch.button("Hush", icon="bell"))
    """Ring the Hushbell at the pointer: true sight there for a few seconds, enemy wards caught in it break."""
    stop = button(keyboard="KeyS", gamepad=gamepad.SOUTH)
    recall = button(keyboard="KeyB", gamepad=gamepad.SELECT, touch=touch.button("Recall", icon="home"))
    shop = button(keyboard="KeyO", gamepad=gamepad.START, touch=touch.button("Shop", icon="bag"))
    menu = button(keyboard="KeyP", touch=touch.button("Menu", icon="menu"))
    """Opens and closes the in-match menu."""
    talk = button(keyboard="KeyV")
    """Hold to talk to everyone in the match (voice)."""


ABILITY_KEYS = (Controls.ability_q, Controls.ability_w, Controls.ability_e, Controls.ability_r)

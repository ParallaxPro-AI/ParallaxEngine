"""Controls live in every situation. On-foot, driving, photo and job controls live in their features and
switch themselves on and off with `active_when`."""

from parallax import Actions, Color, TouchSkin, axis2, button, gamepad, mouse, touch
from project import Scenes


class Controls(Actions):
    """Looking around (the camera rig turns with `look` on foot, driving and through the viewfinder) and
    pausing. Scoped to the city, so P does nothing on the title screen."""

    look = axis2(mouse=mouse.DELTA, gamepad=gamepad.RIGHT_STICK, touch=touch.LOOK)
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

    scenes = [Scenes.sunset_bay]
    touch_skin = TouchSkin(
        fill=Color.hex("#0d1d26b8"), stroke=Color.hex("#93d8bd52"), ink=Color.hex("#f4efe6"),
        pressed=Color.hex("#fbbf24"), accent=Color.hex("#fbbf24"),
        joystick_base=Color.hex("#0d1d2640"), joystick_knob=Color.hex("#fbbf24"),
        shape="rounded", stroke_width=1, blur=8, press_scale=0.94, font="Inter, system-ui, sans-serif",
    )
    """The template's Sunset Bay touch skin: translucent teal-navy rounded plates, off-white
    captions, an amber pressed fill and knob, a thin mint ring."""

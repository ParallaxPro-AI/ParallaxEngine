"""The phone, and looking through its camera."""

from parallax import Actions, axis1, button, gamepad, mouse, touch

from features.phone.resources import PhotoMode


class PhoneControls(Actions):
    """O opens and closes the phone, wherever the player is."""

    phone = button(keyboard="KeyO", gamepad=gamepad.DPAD_UP, touch=touch.button("Phone", icon="phone"))


class PhotoControls(Actions):
    """Live while looking through the viewfinder. On-foot and driving controls step aside on their own."""

    zoom = axis1(mouse=mouse.WHEEL, gamepad=gamepad.DPAD_DOWN | gamepad.DPAD_UP)
    shutter = button(mouse=mouse.LEFT, keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button("Shutter", icon="camera"))
    done = button(keyboard="Backspace", gamepad=gamepad.EAST, touch=touch.button("Done", icon="x"))

    active_when = lambda ctx, owner: ctx.get(PhotoMode).active

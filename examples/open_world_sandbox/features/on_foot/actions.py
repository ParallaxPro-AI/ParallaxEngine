"""Sam's controls on foot."""

from parallax import Actions, axis2, button, gamepad, keys, mouse, touch
from parallax.characters import Character

from features.on_foot.tags import Player
from features.phone.feature import PhotoMode


def in_a_car(ctx, owner) -> bool:
    """Is the player in a car? `owner` is None when a system (or the touch layout) asks."""
    if owner is None:
        row = ctx.world.query(Character, tagged=Player).first()
        return row is not None and row[1].vehicle is not None
    return owner.get(Character).vehicle is not None


class OnFootControls(Actions):
    """Walking, shooting and getting into cars. Live while the player is out of a car and not looking
    through the phone's camera, so the same keys can drive or take photos without conflicts."""

    move = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    run = button(keyboard="ShiftLeft", gamepad=gamepad.LEFT_TRIGGER)
    jump = button(keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button("Jump", icon="chevrons_up"))
    fire = button(mouse=mouse.LEFT, gamepad=gamepad.RIGHT_TRIGGER, touch=touch.button("Fire", icon="target"))
    reload = button(keyboard="KeyR", gamepad=gamepad.WEST, touch=touch.button("Reload", icon="refresh"))
    next_weapon = button(mouse=mouse.WHEEL, gamepad=gamepad.RIGHT_SHOULDER, touch=touch.button("Weapon", icon="sword"))
    cover = button(keyboard="KeyC", gamepad=gamepad.EAST, touch=touch.button("Cover", icon="shield"))
    enter = button(keyboard="KeyE", gamepad=gamepad.NORTH, touch=touch.button("Enter car", icon="hand"))

    active_when = lambda ctx, owner: not in_a_car(ctx, owner) and not ctx.get(PhotoMode).active

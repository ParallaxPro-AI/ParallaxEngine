"""The contracts board, and the job keys behind the wheel."""

from parallax import Actions, button, gamepad, touch

from features.driving.feature import player_car
from features.phone.feature import PhotoMode


class BoardControls(Actions):
    """J opens and closes the contracts board."""

    contracts = button(keyboard="KeyJ", gamepad=gamepad.DPAD_LEFT)


class JobControls(Actions):
    """Handing cargo over in a loading bay. Live behind the wheel, like the driving controls; read by the
    contract quests' verbs, which have no owner entity, so the condition is asked of the world."""

    handover = button(keyboard="KeyK", gamepad=gamepad.WEST, touch=touch.button("Hand over", icon="package"))
    fast_pickup = button(keyboard="KeyB", gamepad=gamepad.RIGHT_SHOULDER, touch=touch.button("Fast pickup", icon="zap"))

    active_when = lambda ctx, owner: player_car(ctx) is not None and not ctx.get(PhotoMode).active

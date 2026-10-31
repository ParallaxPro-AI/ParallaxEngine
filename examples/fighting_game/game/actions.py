"""The player's verbs. Touch buttons, gamepad and remapping all come from these tables.
The touch controls wear the original's skin (frosted teal-navy glass circles, a hairline
ink ring, cyan when pressed, gold accent) and its right-thumb cluster: Light under the
thumb, Heavy / Bolt / Super arcing around it; Super's ring fills as SPIRIT reaches 50."""

from parallax import Actions, Color, Context, Settings, TouchSkin, axis2, button, gamepad, keys, touch
from project import Content, Placed

from game.components import Fighter
from game.resources import BOUT_PHASES, Match

# The default keys, named once: the controls below bind them, and the HUD legend, the
# lesson card and the moves panel show them (with any remap from the settings panel).
LIGHT_KEY = "KeyJ"
HEAVY_KEY = "KeyK"
BOLT_KEY = "KeyU"
SUPER_KEY = "KeyI"
GUARD_KEY = "KeyL"
DEFAULT_KEYS = {"light": LIGHT_KEY, "heavy": HEAVY_KEY, "bolt": BOLT_KEY, "super": SUPER_KEY, "guard": GUARD_KEY}


def super_charging(ctx: Context) -> float:
    """0..1 of the SPIRIT still missing for the super (the touch button's sweep)."""
    cost = Content.move.circuit_breaker.data.meter_cost
    meter = ctx.world.placed(Placed.challenger).get(Fighter).meter
    return max(0.0, 1 - meter / cost)


class Controls(Actions):
    touch_skin = TouchSkin(
        fill=Color.hex("#0a1b259e"),
        stroke=Color.hex("#eef2e74d"),
        ink=Color.hex("#eef2e7"),
        pressed=Color.hex("#67dce057"),
        accent=Color.hex("#efc17d"),
        shape="circle",
        font="Inter, system-ui, sans-serif",
    )
    move = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    jump = button(gamepad=gamepad.SOUTH)
    light = button(keyboard=LIGHT_KEY, gamepad=gamepad.WEST, touch=touch.button("touch_light", icon="fist", zone="primary"))
    heavy = button(keyboard=HEAVY_KEY, gamepad=gamepad.NORTH, touch=touch.button("touch_heavy", icon="star"))
    bolt = button(keyboard=BOLT_KEY, gamepad=gamepad.EAST, touch=touch.button("touch_bolt", icon="spark"))
    super = button(keyboard=SUPER_KEY, gamepad=gamepad.RIGHT_SHOULDER,
                   touch=touch.button("touch_super", icon="lightning", cooldown=super_charging))
    guard = button(keyboard=GUARD_KEY, gamepad=gamepad.LEFT_TRIGGER, touch=touch.button("touch_guard", icon="shield"))


class BoutControls(Actions):
    """Live only while a bout is on screen, so P can't pause over the title or result.
    The title is a modal over the arena (one scene), so `scenes=` can't express this."""
    pause = button(keyboard="KeyP", gamepad=gamepad.START)

    @staticmethod
    def active_when(ctx, owner):
        return ctx.get(Match).phase in BOUT_PHASES


def key_caps(ctx: Context) -> dict[str, str]:
    """The letter on each attack's key cap ("J"), following remaps from the settings panel."""
    remapped = ctx.get(Settings).controls
    caps = {}
    for action, default in DEFAULT_KEYS.items():
        code = remapped.get(f"Controls.{action}:key", default)
        caps[action] = code[3:] if code.startswith("Key") else code
    return caps

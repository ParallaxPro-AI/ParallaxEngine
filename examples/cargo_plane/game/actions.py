"""Controls, out in the archipelago only. Which of walking and flying is live is
derived from where the pilot is; touch labels are locale keys. The touch layout and
skin are the template's (platforms.controls): on foot a floating stick, Board as the
primary button (greyed out until a plane is in reach), Jump, and Office only beside a
pad; in the cockpit a power stick, a fixed attitude stick, and Exit Plane / Office only
once the plane has stopped. Flaps and brakes have no touch button, as in the template."""

from parallax import Actions, Color, TouchSkin, axis2, button, gamepad, keys, mouse, touch
from parallax.vehicles import Vehicle
from project import Scenes

from game.config import FreightRules
from game.readout import office_open_here
from game.rules import at_the_controls, flown, plane_in_reach

MANIFEST_GLASS = TouchSkin(
    fill=Color.hex("#0206178c"), stroke=Color.hex("#bae6fd8c"), ink=Color.hex("#fef3c7"),
    pressed=Color.hex("#7dd3fc4d"), accent=Color.hex("#7dd3fc"), shape="circle",
    font="'IBM Plex Mono', 'Courier New', monospace",
)


def stopped(ctx) -> bool:
    """In a plane that has (nearly) stopped: the cockpit's touch buttons show."""
    plane = flown(ctx)
    return plane is not None and abs(plane.get(Vehicle).speed) < ctx.config(FreightRules).touch_stopped_speed


def interact_shown(ctx) -> bool:
    return not at_the_controls(ctx) or (stopped(ctx) and plane_grounded(ctx))


def plane_grounded(ctx) -> bool:
    plane = flown(ctx)
    return plane is not None and plane.get(Vehicle).grounded


def interact_label(ctx):
    return ("exit_plane", "exit") if at_the_controls(ctx) else None


def office_shown(ctx) -> bool:
    return office_open_here(ctx) and (not at_the_controls(ctx) or stopped(ctx))


class Controls(Actions):
    """On foot and in the cockpit."""
    scenes = [Scenes.archipelago]
    touch_skin = MANIFEST_GLASS

    interact = button(keyboard="KeyE", gamepad=gamepad.NORTH,
                      touch=touch.button("board", icon="hand", visible_when=interact_shown,
                                         enabled_when=lambda ctx: at_the_controls(ctx) or plane_in_reach(ctx) is not None,
                                         relabel=interact_label))
    office = button(keyboard="KeyB", gamepad=gamepad.WEST,
                    touch=touch.button("office", icon="box", visible_when=office_shown))
    pause = button(keyboard="KeyP", gamepad=gamepad.START)


class WalkControls(Actions):
    """While the pilot is on foot: `look` orbits the camera round him (the engine's orbit rig
    reads the live action named `look`) and `move` walks him relative to that view. Scoped to
    the archipelago and to being on foot, so the title, menus and the cockpit keep a free cursor."""
    scenes = [Scenes.archipelago]

    look = axis2(mouse=mouse.DELTA, gamepad=gamepad.RIGHT_STICK, touch=touch.LOOK)
    move = axis2(keyboard=keys.WASD, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    jump = button(keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button("jump", icon="chevrons_up"))

    @staticmethod
    def active_when(ctx, owner):
        return not at_the_controls(ctx)


class FlightControls(Actions):
    """While the pilot is in the cockpit. `power`: y = throttle lever, x = rudder.
    `stick`: y = pitch (up = nose up), x = roll."""
    scenes = [Scenes.archipelago]

    power = axis2(keyboard=keys.WASD, gamepad=gamepad.RIGHT_STICK, touch=touch.joystick("left"))
    stick = axis2(keyboard=keys.composite(up="KeyI", left="KeyJ", down="KeyK", right="KeyL") | keys.ARROWS,
                  gamepad=gamepad.LEFT_STICK, touch=touch.joystick("right", fixed=True))
    flaps = button(keyboard="KeyF", gamepad=gamepad.RIGHT_SHOULDER, touch=touch.NONE)
    brakes = button(keyboard="Space", gamepad=gamepad.LEFT_SHOULDER, touch=touch.NONE)

    @staticmethod
    def active_when(ctx, owner):
        return at_the_controls(ctx)

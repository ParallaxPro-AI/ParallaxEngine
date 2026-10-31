"""The hero's own controls. The orbit camera turns with `look`."""

from parallax import Actions, Color, Context, TouchSkin, axis2, button, gamepad, keys, mouse, touch

from features.hero.components import Dodge, Hero


def dodge_left(ctx: Context) -> float:
    row = ctx.world.query(Dodge, tagged=Hero).first()
    return 0.0 if row is None or row[1].ready.done else row[1].ready.remaining / max(row[1].ready.duration, 0.01)


class HeroControls(Actions):
    """Moving, looking, running, jumping and dodging."""

    move = axis2(keyboard=keys.WASD | keys.ARROWS, gamepad=gamepad.LEFT_STICK, touch=touch.joystick("left"))
    look = axis2(mouse=mouse.DELTA, gamepad=gamepad.RIGHT_STICK, touch=touch.LOOK)
    run = button(keyboard="ShiftLeft", gamepad=gamepad.LEFT_SHOULDER)
    jump = button(keyboard="Space", gamepad=gamepad.SOUTH, touch=touch.button("Jump", icon="chevrons_up", at=(0.697, 0.887), size=0.96))
    # The template's "Lantern Glass" touch skin (game.json platforms.controls.skin).
    touch_skin = TouchSkin(
        fill=Color.hex("#0d181b").with_alpha(0.92), stroke=Color.hex("#e0c48c").with_alpha(0.62), ink=Color.hex("#f4efdc"),
        pressed=Color.hex("#243c3e").with_alpha(0.96), accent=Color.hex("#c9a865"), shape="circle", font="Inter",
        joystick_base=Color.hex("#0f1b1f").with_alpha(0.45), joystick_knob=Color.hex("#13252a"),
        stroke_width=1.5, blur=4, press_scale=0.94,
    )
    dodge = button(keyboard="KeyC", gamepad=gamepad.EAST, mouse=mouse.RIGHT, touch=touch.button("Dodge", icon="wind", at=(0.775, 0.867), size=1.2,
                                     cooldown=dodge_left, enabled_when=lambda ctx: dodge_left(ctx) <= 0))

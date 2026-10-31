"""Radial wheel (library piece `radial_menu`).

The wheel is open while `RadialControls.wheel` is held (Q / Left shoulder). Its options
are `radial_option` content in `group`, in `order`, laid clockwise from the top. While it
is held, the aim stick (right stick or arrow keys) past `deadzone` highlights the sector
it points into; the highlight is the `RadialState` resource, so it stays put when the stick
springs back. Letting go with a highlight — or clicking a slot — emits `RadialPicked`.
What a pick means (switch weapon, play an emote) is the game's handler."""

import math

from parallax import (
    Actions, ContentRef, Localized, Panel, System, Vec2, axis2, button, config, content, event,
    field, gamepad, keys, resource, system, ui,
)

from game.lib.scene_tags import Playable


@content("radial_option", order="order")
class RadialOptionDef:
    label: Localized
    icon: str = field("", doc="A glyph shown in the slot.")
    group: str = field("main", doc="Which wheel it belongs to.")
    order: int = field(0)


@config("radial_menu")
class RadialMenuConfig:
    """config/radial_menu.json."""
    group: str = field("main")
    deadzone: float = field(0.5, min=0, max=1)


@resource("radial_state", keep="scene")
class RadialState:
    highlight: int = field(-1, doc="Index into the wheel's options; -1 = none.")


@event("radial_picked")
class RadialPicked:
    option: ContentRef[RadialOptionDef]
    group: str


class RadialControls(Actions):
    scenes = [Playable]
    wheel = button(keyboard="KeyQ", gamepad=gamepad.LEFT_SHOULDER)
    aim = axis2(keyboard=keys.ARROWS, gamepad=gamepad.RIGHT_STICK)


def options(ctx) -> list[ContentRef[RadialOptionDef]]:
    group = ctx.config(RadialMenuConfig).group
    return ctx.content(RadialOptionDef).where(lambda o: o.group == group)


def sector(direction: Vec2, count: int) -> int:
    """Clockwise sector index from the top for a stick direction (y up)."""
    if count == 0:
        return -1
    heading = math.degrees(math.atan2(direction.x, direction.y)) % 360
    width = 360 / count
    return int(((heading + width / 2) % 360) // width)


def pick(ctx, option: ContentRef[RadialOptionDef]):
    ctx.emit(RadialPicked(option=option, group=ctx.config(RadialMenuConfig).group))
    ctx.get(RadialState).highlight = -1


@system("radial_selection", scenes=[Playable])
class RadialSelection(System):
    """Tracks the highlighted sector while the wheel is held; picks it on release."""

    def update(self, ctx, dt):
        state = ctx.get(RadialState)
        wheel = options(ctx)
        if ctx.input.held(RadialControls.wheel):
            aim = ctx.input.axis(RadialControls.aim)
            if aim.length() >= ctx.config(RadialMenuConfig).deadzone:
                state.highlight = sector(aim, len(wheel))
        elif ctx.input.released(RadialControls.wheel) and 0 <= state.highlight < len(wheel):
            pick(ctx, wheel[state.highlight])
        else:
            state.highlight = -1


@ui("radial_menu", html="ui/lib/radial_menu.html", layer="overlay", scenes=[Playable],
    while_held=RadialControls.wheel)
class RadialMenu(Panel):
    actions = {"pick": pick}

    def state(self, ctx):
        wheel = options(ctx)
        lit = ctx.get(RadialState).highlight
        count = max(1, len(wheel))
        slots = []
        for i, option in enumerate(wheel):
            angle = math.radians(i * 360 / count)
            slots.append({
                "option": option.id,
                "label": ctx.text(option.data.label),
                "icon": option.data.icon,
                "lit": i == lit,
                "x": f"{50 + 38 * math.sin(angle):.1f}%",
                "y": f"{50 - 38 * math.cos(angle):.1f}%",
            })
        return {"slots": slots, "current": slots[lit]["label"] if 0 <= lit < len(slots) else ""}

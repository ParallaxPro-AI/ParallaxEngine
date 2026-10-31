"""Arming a seed, the watering can or the trowel. These are the HUD's actions; the
`Tools` system calls the same functions for hotkeys and the gamepad."""

from parallax import Context, ContentRef
from project import Text

from game.content import PlantDef
from game.lawn import current_level
from game.notes import HINT_SECONDS, say
from game.resources import Irrigation, Planting, Pollen, Tool


def arm_seed(ctx: Context, plant: ContentRef[PlantDef]) -> None:
    """Arm a seed, unless it's still recharging or costs more pollen than there is."""
    planting = ctx.get(Planting)
    say(ctx, f"{ctx.text(plant.data.name)} · {ctx.text(plant.data.blurb)}", HINT_SECONDS)
    wait = planting.seed_ready_at.get(plant, 0) - ctx.time.now
    if wait > 0:
        say(ctx, ctx.text(Text.notice_seed_recharging, seconds=round(wait, 1)))
    elif ctx.get(Pollen).amount < plant.data.cost:
        say(ctx, ctx.text(Text.notice_need_pollen, cost=plant.data.cost))
    else:
        planting.tool, planting.seed = Tool.SEED, plant


def arm_watering_can(ctx: Context) -> None:
    """Arm the watering can, in gardens with irrigation, once the last watering settles."""
    if not current_level(ctx).irrigation:
        return
    wait = ctx.get(Irrigation).ready_at - ctx.time.now
    if wait > 0:
        say(ctx, ctx.text(Text.notice_water_settling, seconds=round(wait, 1)))
        return
    ctx.get(Planting).tool = Tool.WATER
    say(ctx, ctx.text(Text.notice_choose_row))


def arm_trowel(ctx: Context) -> None:
    """Arm the trowel: dig up a plant for part of its pollen back."""
    ctx.get(Planting).tool = Tool.DIG
    say(ctx, f"{ctx.text(Text.trowel)} · {ctx.text(Text.trowel_blurb)}", HINT_SECONDS)


def disarm(ctx: Context) -> None:
    """Put the armed tool away."""
    ctx.get(Planting).tool = Tool.NONE

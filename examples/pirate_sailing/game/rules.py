"""Read-only helpers over the current leg, the refit build and the weather."""

from parallax import Context

from game.components import Squall
from game.config import VoyageRules
from game.content import LegDef, Stat, UpgradeDef
from game.resources import Phase, Voyage


def current_leg(ctx: Context) -> LegDef:
    return ctx.config(VoyageRules).legs[ctx.get(Voyage).leg].data


def is_last_leg(ctx: Context) -> bool:
    return ctx.get(Voyage).leg == len(ctx.config(VoyageRules).legs) - 1


def sailing(ctx: Context) -> bool:
    return ctx.get(Voyage).phase is Phase.SAILING


def squall_raging(ctx: Context) -> bool:
    return ctx.world.query(Squall).count() > 0


def refit(ctx: Context, stat: Stat) -> float:
    """Everything the refit build adds to one stat."""
    levels = ctx.get(Voyage).levels
    return sum(u.data.amount * levels.get(u.id, 0) for u in ctx.content(UpgradeDef) if u.data.stat is stat)


def reload_scale(ctx: Context) -> float:
    """Powder Monkeys compound: each stack cuts what's left of the reload by its amount."""
    levels = ctx.get(Voyage).levels
    scale = 1.0
    for u in ctx.content(UpgradeDef):
        if u.data.stat is Stat.RELOAD_CUT:
            scale *= (1 - u.data.amount) ** levels.get(u.id, 0)
    return scale


def crew_left(ctx: Context) -> int:
    return ctx.config(VoyageRules).crew + int(refit(ctx, Stat.CREW)) - ctx.get(Voyage).sinkings

"""Read-only questions about the run, shared by systems, behaviors and panels."""

from parallax import Context

from game.config import Rules
from game.content import RivalDef
from game.resources import Duel, Mods, Run


def current_rival(ctx: Context) -> RivalDef:
    return ctx.content(RivalDef)[ctx.get(Run).rival_index].data


def is_final_rival(ctx: Context) -> bool:
    return ctx.get(Run).rival_index == len(ctx.content(RivalDef)) - 1


def shields_left(ctx: Context) -> int:
    return ctx.get(Mods).shields - ctx.get(Duel).shields_used


def run_over(ctx: Context) -> bool:
    return ctx.get(Run).won or ctx.get(Duel).rival_points == ctx.config(Rules).win_score

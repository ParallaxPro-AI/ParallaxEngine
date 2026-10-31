"""Read-only questions about the run, shared by systems, behaviors and panels."""

from parallax import Color, Context, clamp

from game.config import Rules
from game.content import StageDef
from game.resources import Mods, Run


def current_stage(ctx: Context) -> StageDef:
    return ctx.content(StageDef)[ctx.get(Run).stage_index].data


def is_final_stage(ctx: Context) -> bool:
    return ctx.get(Run).stage_index == len(ctx.content(StageDef)) - 1


def lives_left(ctx: Context) -> int:
    return ctx.config(Rules).lives + ctx.get(Mods).extra_lives - ctx.get(Run).balls_lost


def run_over(ctx: Context) -> bool:
    return ctx.get(Run).won or lives_left(ctx) == 0


def lit(color: Color, k: float) -> Color:
    """A stage colour scaled by `k` the way the template tinted its bricks and rails: the
    template's colours are linear (its renderer's material space), so the scaled value is
    encoded to the sRGB a Shape takes."""
    def encode(c: float) -> float:
        c = clamp(c * k, 0, 1)
        return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
    return Color(encode(color.r), encode(color.g), encode(color.b))

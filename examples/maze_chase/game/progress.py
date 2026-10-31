"""Read-only questions about the run, shared by systems, behaviors and panels."""

from parallax import Context, lerp

from game.components import Stalker
from game.config import Knob, Rules
from game.content import LevelDef
from game.resources import Board, Hunt, Mode, Pace, Run


def current_level(ctx: Context) -> LevelDef:
    return ctx.content(LevelDef)[ctx.get(Run).level_index].data


def is_final_level(ctx: Context) -> bool:
    return ctx.get(Run).level_index == len(ctx.content(LevelDef)) - 1


def lives_left(ctx: Context) -> int:
    return ctx.config(Rules).lives - ctx.get(Run).lives_lost


def run_over(ctx: Context) -> bool:
    return ctx.get(Run).won or lives_left(ctx) == 0


def getting_ready(ctx: Context) -> bool:
    return not ctx.get(Board).ready.done


def knob(ctx: Context, dial: Knob) -> float:
    """A difficulty multiplier at the current pace (1.0 at the default pace)."""
    return lerp(dial.gentlest, dial.hardest, ctx.get(Pace).level)


def stalker_mode(ctx: Context, stalker: Stalker) -> Mode:
    if stalker.eaten:
        return Mode.EATEN
    hunt = ctx.get(Hunt)
    return Mode.FRIGHTENED if not hunt.fright.done else hunt.phase

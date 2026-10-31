"""Helpers over the run: its stage, its relics added together, the draft and scoring."""

import random
from dataclasses import dataclass

from parallax import Context, ContentRef

from game.config import Rules
from game.content import RelicDef, StageDef
from game.resources import Records, Run


def stage_count(ctx: Context) -> int:
    return len(ctx.content(StageDef))


def current_stage(ctx: Context) -> StageDef:
    return ctx.content(StageDef)[ctx.get(Run).stage_index].data


def is_final_stage(ctx: Context) -> bool:
    return ctx.get(Run).stage_index == stage_count(ctx) - 1


@dataclass(frozen=True)
class Mods:
    """The run's relics added together."""
    extra_moves: int
    score_bonus: float
    cascade_bonus: float
    start_bombs: int
    start_lines: int
    thaw: bool
    refund_on_special: bool
    fewer_kinds: int
    bomb_radius_bonus: int
    leftover_bonus: float


def mods(run: Run) -> Mods:
    relics = [r.data for r in run.relics]
    return Mods(
        extra_moves=sum(r.extra_moves for r in relics),
        score_bonus=sum(r.score_bonus for r in relics),
        cascade_bonus=sum(r.cascade_bonus for r in relics),
        start_bombs=sum(r.start_bombs for r in relics),
        start_lines=sum(r.start_lines for r in relics),
        thaw=any(r.thaw for r in relics),
        refund_on_special=any(r.refund_on_special for r in relics),
        fewer_kinds=sum(r.fewer_kinds for r in relics),
        bomb_radius_bonus=sum(r.bomb_radius_bonus for r in relics),
        leftover_bonus=sum(r.leftover_bonus for r in relics),
    )


def roll_offer(ctx: Context) -> list[ContentRef[RelicDef]]:
    """Up to `relic_offers` relics the run doesn't carry yet. Each is offered once per run."""
    owned = set(ctx.get(Run).relics)
    pool = [relic for relic in ctx.content(RelicDef) if relic not in owned]
    return random.sample(pool, min(ctx.config(Rules).relic_offers, len(pool)))


def award(ctx: Context, points: float) -> None:
    """Add points to the stage and the run, scaled by the run's score relics."""
    run = ctx.get(Run)
    gained = int(points * (1 + mods(run).score_bonus))
    run.stage_score += gained
    run.run_score += gained
    records = ctx.get(Records)
    records.best_run = max(records.best_run, run.run_score)

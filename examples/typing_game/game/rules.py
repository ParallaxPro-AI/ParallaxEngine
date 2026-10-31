"""The run's difficulty curve and statistics, as functions of the config, the run and
the run clock (`ctx.time.scene_time`: 0 at every load, stopped while a modal is open)."""

import random

from parallax import Context, ContentRef, Vec2, Vec3, clamp, vec2
from project import Placed

from game.config import Rules, WordPool
from game.content import WordKindDef
from game.resources import Run


# Difficulty: everything rises with the seconds survived.

def fall_speed(ctx: Context) -> float:
    rules = ctx.config(Rules)
    return min(rules.max_speed, rules.base_speed + rules.speed_ramp * ctx.time.scene_time)


def spawn_interval(ctx: Context) -> float:
    rules = ctx.config(Rules)
    return max(rules.min_interval, rules.base_interval - rules.interval_ramp * ctx.time.scene_time)


def threat(ctx: Context) -> float:
    """How far along the speed ramp the run is, 0..1 (the HUD's threat bar)."""
    rules = ctx.config(Rules)
    return (fall_speed(ctx) - rules.base_speed) / (rules.max_speed - rules.base_speed)


def kind_chance(kind: WordKindDef, seconds: float) -> float:
    return kind.max_chance * clamp((seconds - kind.appears_after) / kind.ramp_seconds, 0, 1)


def roll_kind(ctx: Context) -> ContentRef[WordKindDef]:
    rules = ctx.config(Rules)
    roll = random.random()
    for kind in rules.rare_kinds:
        chance = kind_chance(kind.data, ctx.time.scene_time)
        if roll < chance:
            return kind
        roll -= chance
    return rules.base_kind


def random_word(ctx: Context) -> str:
    return random.choice(ctx.config(WordPool).words)


# Statistics.

def lives_left(ctx: Context) -> int:
    return max(0, ctx.config(Rules).lives - ctx.get(Run).breached)


def accuracy(run: Run) -> float:
    """Fraction of keystrokes that were right. A run with no keystrokes is perfect."""
    return run.keys_correct / run.keys_total if run.keys_total else 1.0


def wpm(ctx: Context) -> int:
    """Correct characters per minute, in standard five-character words."""
    rules = ctx.config(Rules)
    minutes = max(rules.wpm_min_seconds, ctx.time.scene_time) / 60
    return round(ctx.get(Run).keys_correct / rules.chars_per_word / minutes)


def grade(ctx: Context) -> str:
    score = accuracy(ctx.get(Run))
    return next(g.letter for g in ctx.config(Rules).grades if score >= g.min_accuracy)


# Where a word sits on the HUD's word field: across by column, down by how far it has
# fallen from the uplink to the firewall (the template's flat chip layout, not a projection).

def field_point(ctx: Context, at: Vec3) -> Vec2:
    columns = ctx.config(Rules).columns
    top = ctx.world.placed(Placed.uplink).transform.position.z
    bottom = ctx.world.placed(Placed.firewall).transform.position.z
    return vec2(clamp((at.x - columns[0]) / (columns[-1] - columns[0]), 0, 1),
                clamp((at.z - top) / (bottom - top), 0, 1))

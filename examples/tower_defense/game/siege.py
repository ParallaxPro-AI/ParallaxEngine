"""Questions about the battlefield shared by systems, behaviors and panels."""

import math

from parallax import Context, ContentRef, Entity

from game.components import Turret
from game.config import SiegeRules
from game.content import LevelDef, TowerDef, TowerLevel
from game.resources import Campaign, Result, Siege


def current_level(ctx: Context) -> LevelDef:
    return ctx.get(Campaign).level.data


def stats(tower: ContentRef[TowerDef], level: int) -> TowerLevel:
    """A tower's numbers at a level."""
    return tower.data.levels[level - 1]


def tower_on(pad: Entity) -> Entity | None:
    return next((child for child in pad.children if child.has(Turret)), None)


def sell_value(ctx: Context, turret: Turret) -> int:
    spent = sum(level.cost for level in turret.kind.data.levels[: turret.level])
    return math.floor(spent * ctx.config(SiegeRules).sell_refund)


def wave_in_progress(ctx: Context) -> bool:
    """A wave is marching out or still on the field."""
    march = ctx.get(Siege).march
    return march is not None and march.active


def playing(ctx: Context) -> bool:
    """The battlefield is neither won nor lost yet."""
    return ctx.get(Siege).result is Result.PLAYING

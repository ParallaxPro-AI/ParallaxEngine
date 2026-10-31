"""The experience curve, shared by the leveling system and the HUD's experience bar."""

import math

from features.hero.config import HeroCurve


def xp_to_next(curve: HeroCurve, level: int) -> int:
    """Experience needed to climb from `level` to the next: 100, 150, 225, 337… with the shipped curve."""
    need = curve.first_level_xp
    for _ in range(level - 1):
        need = math.floor(need * curve.xp_growth)
    return need

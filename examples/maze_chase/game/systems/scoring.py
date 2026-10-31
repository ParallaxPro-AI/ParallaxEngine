from parallax import Color, System, on, system

from game.config import Rules
from game.events import LevelCleared, PipEaten, StalkerEaten
from game.resources import Run


POP_COLOR = Color.hex("#7fdcff")
"""The "+400" over an eaten Stalker: the kit's neon cyan."""


@system("scoring")
class Scoring(System):
    """Points for pips and flares, for each Stalker eaten (doubling along a flare's
    chain), and for clearing a level."""

    @on(PipEaten)
    def pip_eaten(self, ctx, event: PipEaten):
        rules = ctx.config(Rules)
        ctx.get(Run).score += rules.flare_score if event.flare else rules.pip_score

    @on(StalkerEaten)
    def stalker_eaten(self, ctx, event: StalkerEaten):
        rules = ctx.config(Rules)
        points = rules.stalker_score * 2 ** (min(event.chain, rules.max_chain) - 1)
        ctx.get(Run).score += points
        ctx.ui.float_text(f"+{points}", at=event.stalker.transform.position, color=POP_COLOR)

    @on(LevelCleared)
    def level_cleared(self, ctx, event: LevelCleared):
        ctx.get(Run).score += ctx.config(Rules).level_bonus

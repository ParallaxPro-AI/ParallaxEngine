from parallax import System, on, system
from project import Scenes

from game.content import TierDef, par_total
from game.events import MatchEnded
from game.resources import Career, Match


@system("tour", scenes=[Scenes.oche_hall])
class Tour(System):
    """The arc across matches: banks each finished match in the career records,
    and opens the next tier for a match won inside the budget. (Picking a tier on
    the title card is the panel's `step_tier`.)"""

    @on(MatchEnded)
    def bank(self, ctx, event: MatchEnded):
        match = ctx.get(Match)
        career = ctx.get(Career)
        career.matches += 1
        career.bullseyes += match.bullseyes
        career.best_score = max(career.best_score, match.score)
        if not event.won:
            return
        over_par = match.total_darts - par_total(ctx)
        if career.best_over_par is None or over_par < career.best_over_par:
            career.best_over_par = over_par
        ladder = ctx.content(TierDef)
        if career.tier == career.unlocked and career.unlocked + 1 < len(ladder):
            career.unlocked += 1
            career.tier = career.unlocked
            match.unlocked = ladder[career.unlocked]

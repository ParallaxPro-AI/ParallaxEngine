from parallax import System, on, system

from game.components import Smash
from game.config import Rules
from game.events import BallReturned, BallServed, DuelWon, RallyEnded
from game.resources import Mods, Run


@system("scoring")
class Scoring(System):
    """Run score: points for every return the player makes, for every point won
    (worth more after a long rally), and for every duel won."""

    @on(BallServed)
    def served(self, ctx, event: BallServed):
        ctx.get(Run).rally = 0

    @on(BallReturned, where=lambda event: event.source.has(Smash))
    def player_returned(self, ctx, event: BallReturned):
        run = ctx.get(Run)
        run.rally += 1
        run.best_rally = max(run.best_rally, run.rally)
        run.score += int(ctx.config(Rules).rally_score * ctx.get(Mods).rally_score)

    @on(RallyEnded, where=lambda event: event.player_scored)
    def point_won(self, ctx, event: RallyEnded):
        rules = ctx.config(Rules)
        run = ctx.get(Run)
        run.score += rules.point_score + int(run.rally * rules.rally_score * ctx.get(Mods).rally_score)

    @on(DuelWon)
    def duel_won(self, ctx, event: DuelWon):
        ctx.get(Run).score += ctx.config(Rules).duel_score

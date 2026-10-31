from parallax import SceneLoaded, System, on, system

from game.audio import Sounds, play
from game.components import Home
from game.content import CupRules
from game.events import BallStruck, KeeperSaved, PossessionWon, Strike, TieDecided
from game.resources import Career, Cup, Match, Result
from game.training import apply_all, deal


@system("cup_run")
class CupRun(System):
    """The knockout cup around the matches.

    Win a tie and the team talk deals training cards (the panel opens while offers
    are on the table; its pick action starts the next round). Lose a tie and you are
    knocked out; win the final and the cup is yours. Also keeps the stats sheet and
    the career record."""

    @on(SceneLoaded)
    def restore_training(self, ctx, event):
        apply_all(ctx)

    @on(TieDecided)
    def tie_decided(self, ctx, event):
        cup, match, career = ctx.get(Cup), ctx.get(Match), ctx.get(Career)
        career.ties_played += 1
        career.ties_won += 1 if event.won else 0
        career.goals_for += match.home_goals
        career.goals_against += match.away_goals
        career.best_round = max(career.best_round, cup.round + (1 if event.won else 0))

        if not event.won:
            cup.result = Result.KNOCKED_OUT
            play(ctx, ctx.config(Sounds).knocked_out)
        elif cup.round == len(ctx.config(CupRules).rounds) - 1:
            cup.result = Result.CHAMPIONS
            career.cups_won += 1
            play(ctx, ctx.config(Sounds).cup_won)
        else:
            cup.offers = deal(ctx)
            play(ctx, ctx.config(Sounds).round_won)

    @on(BallStruck, where=lambda event: event.kind is Strike.SHOT and event.by.has(Home))
    def count_shot(self, ctx, event):
        ctx.get(Cup).shots += 1

    @on(KeeperSaved, where=lambda event: event.keeper.has(Home))
    def count_save(self, ctx, event):
        ctx.get(Cup).saves += 1

    @on(PossessionWon, where=lambda event: event.previous is not None and event.by.has(Home))
    def count_turnover(self, ctx, event):
        ctx.get(Cup).turnovers += 1

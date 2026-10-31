from parallax import SceneLoaded, System, on, system

from game.components import BoxScore
from game.content import CourtRules
from game.events import GameDecided
from game.ladder import apply_perks, deal, tip_off
from game.resources import Career, Result, Run
from game.rules import you


@system("season")
class Season(System):
    """The run up the ladder: five crews, one loss and it's over.

    Win and the locker room deals perk cards (the panel is open while offers are on
    the table; its pick action tips off against the next crew). Win the title game
    and you're champions. Keeps the career record."""

    def start(self, ctx):
        tip_off(ctx)

    @on(SceneLoaded)
    def restore_perks(self, ctx, event):
        apply_perks(ctx)

    @on(GameDecided)
    def game_decided(self, ctx, event):
        run, career = ctx.get(Run), ctx.get(Career)
        career.games_played += 1
        career.games_won += 1 if event.won else 0
        career.best_stage = max(career.best_stage, run.stage + (1 if event.won else 0))
        if not event.won:
            run.result = Result.ELIMINATED
        elif run.stage == len(ctx.config(CourtRules).ladder) - 1:
            run.result = Result.CHAMPIONS
            career.titles += 1
        else:
            run.offers = deal(ctx)
        if run.result is not Result.RUNNING:
            box = you(ctx).get(BoxScore)
            career.points += box.points
            career.greens += box.greens

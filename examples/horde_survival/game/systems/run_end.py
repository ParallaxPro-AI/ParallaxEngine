from parallax import System, on, system
from project import Scenes

from game.events import RunEnded
from game.resources import Choices, Outcome, Records, Run
from game.rules import Rules, play, run_live, scales


@system("run_end", scenes=[Scenes.arena])
class RunEnd(System):
    """The payout. Every run, won or lost, earns ember dust for the shrine, and the
    records remember the best of them. Deciding the outcome opens the end-of-run panel.
    `when=run_live` is checked per delivery, so if the bell and a killing blow land in
    the same frame only the first `RunEnded` counts."""

    @on(RunEnded, when=run_live)
    def ended(self, ctx, event: RunEnded):
        run = ctx.get(Run)
        rules = ctx.config(Rules)
        run.outcome = Outcome.SURVIVED if event.survived else Outcome.FELL
        dust = run.score / 100 * rules.dust_per_hundred_score + run.level * rules.dust_per_level
        if event.survived:
            dust += rules.dust_on_survive * scales(ctx).score
        run.dust_earned = int(dust)

        records = ctx.get(Records)
        seconds = int(min(ctx.time.scene_time, rules.run_seconds))
        run.new_best = run.score > records.best_score
        records.dust += run.dust_earned
        records.best_score = max(records.best_score, int(run.score))
        records.best_seconds = max(records.best_seconds, seconds)
        records.best_level = max(records.best_level, run.level)
        if event.survived:
            records.runs_survived += 1
            if ctx.get(Choices).vigil:
                records.vigil_survived += 1

        play(ctx, rules.sounds.win if event.survived else rules.sounds.lose)

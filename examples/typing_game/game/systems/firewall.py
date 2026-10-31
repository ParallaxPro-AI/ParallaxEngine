from parallax import Context, System, on, system
from project import Scenes

from game.components import Word
from game.events import RunEnded, WordBreached
from game.resources import Records, Run
from game.rules import lives_left, wpm


@system("firewall", scenes=[Scenes.grid])
class Firewall(System):
    """Counts breaches. Each one breaks the combo and costs a life; the last life
    ends the run and banks the records. Endless: there is no win."""

    @on(WordBreached)
    def breached(self, ctx, event):
        run = ctx.get(Run)
        run.combo = 0
        run.breached += 1
        if lives_left(ctx) == 0:
            end_run(ctx)


def end_run(ctx: Context) -> None:
    """Clears the grid and banks the records. The results panel opens by itself (it
    follows `lives_left`)."""
    for entity in ctx.world.query(Word).entities():
        entity.destroy()
    run = ctx.get(Run)
    run.target = None
    records = ctx.get(Records)
    run.new_best = run.score > records.best_score
    records.best_score = max(records.best_score, run.score)
    records.best_wpm = max(records.best_wpm, wpm(ctx))
    records.best_combo = max(records.best_combo, run.max_combo)
    ctx.emit(RunEnded())

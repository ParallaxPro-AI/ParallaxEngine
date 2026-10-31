from parallax import Context, System, on, system
from project import Scenes

from game.components import Crust
from game.config import Rules
from game.descent import award, current_stage, is_final_stage, mods, roll_offer
from game.events import BoardSettled, RelicPicked, RunEnded, StageCleared
from game.resources import Outcome, Records, Run


@system("stages", scenes=[Scenes.board])
class Stages(System):
    """Moves the run along the descent. When the board settles it checks the stage:
    both goals met clears it (leftover moves pay a bonus, then the relic draft or the
    win), no moves left ends the run. The draft and result panels open by themselves,
    following `Run.offer` and `Run.outcome`."""

    @on(BoardSettled)
    def check_stage(self, ctx, event):
        run = ctx.get(Run)
        if run.stage_score >= current_stage(ctx).target and ctx.world.query(Crust).count() == 0:
            clear_stage(ctx)
        elif run.moves_left <= 0:
            end_run(ctx, Outcome.LOST)

    @on(RelicPicked)
    def take_relic(self, ctx, event):
        run = ctx.get(Run)
        if event.relic not in run.offer:
            return
        run.relics.append(event.relic)
        run.offer = []
        next_stage(ctx)


def clear_stage(ctx: Context) -> None:
    run = ctx.get(Run)
    award(ctx, run.moves_left * ctx.config(Rules).points_per_move_left * (1 + mods(run).leftover_bonus))
    records = ctx.get(Records)
    records.best_stage = max(records.best_stage, run.stage_index + 1)
    ctx.emit(StageCleared(stage=run.stage_index + 1))

    if is_final_stage(ctx):
        end_run(ctx, Outcome.WON)
        return
    run.offer = roll_offer(ctx)
    if not run.offer:
        next_stage(ctx)


def next_stage(ctx: Context) -> None:
    ctx.get(Run).stage_index += 1
    ctx.scenes.reload()


def end_run(ctx: Context, outcome: Outcome) -> None:
    ctx.get(Run).outcome = outcome
    ctx.emit(RunEnded(won=outcome is Outcome.WON))

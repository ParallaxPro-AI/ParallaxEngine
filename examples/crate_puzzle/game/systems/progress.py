from parallax import Context, System, Task, on, system
from project import Scenes

from game.config import Rules
from game.events import LevelSolved, ShiftCompleted
from game.level import is_final_level, level_count
from game.resources import Records, Shift


@system("progress", scenes=[Scenes.yard])
class Progress(System):
    """Moves the shift along. A solved level lingers for `solved_pause`, then the next
    level loads, or the last one completes the shift and banks the records."""

    @on(LevelSolved)
    def solved(self, ctx, event):
        ctx.run(advance)


async def advance(ctx: Context, task: Task) -> None:
    await task.seconds(ctx.config(Rules).solved_pause)
    if is_final_level(ctx):
        complete_shift(ctx)
    else:
        next_level(ctx)


def next_level(ctx: Context) -> None:
    shift = ctx.get(Shift)
    shift.level_index += 1
    records = ctx.get(Records)
    records.best_levels = max(records.best_levels, shift.level_index + 1)
    ctx.scenes.reload()


def complete_shift(ctx: Context) -> None:
    """Only a shift played from level 1 can set the fewest-moves record."""
    shift = ctx.get(Shift)
    records = ctx.get(Records)
    records.best_levels = level_count(ctx)
    records.resume_level = 0
    if shift.started_at == 0:
        shift.new_record = records.best_moves == 0 or shift.total_moves < records.best_moves
        if shift.new_record:
            shift.previous_best = records.best_moves
            records.best_moves = shift.total_moves
    shift.complete = True
    ctx.emit(ShiftCompleted(moves=shift.total_moves))

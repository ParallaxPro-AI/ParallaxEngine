from parallax import Context, Entity, System, system
from parallax.grid import Grid, GridCell
from parallax.values import Cell
from project import Scenes

from game.actions import Controls
from game.components import Bot, Crate
from game.config import Rules
from game.events import Bumped, LevelReset, LevelSolved, MoveUndone, Stepped
from game.level import yard_grid, yard_of
from game.resources import Attempt, Shift
from game.sokoban import STEPS, Move, Yard, step, unstep


def in_play(ctx: Context) -> bool:
    """A solved level lingers before the next one and takes no more moves."""
    return not yard_of(ctx.world).solved


def undo(ctx: Context) -> None:
    """Take back the last move (the Z key and the HUD's Undo button)."""
    attempt = ctx.get(Attempt)
    if not attempt.history or not in_play(ctx):
        return
    letter = attempt.history.pop()
    attempt.redo.append(letter)
    perform(ctx, unstep(yard_of(ctx.world), letter))
    count(ctx, letter, -1)
    ctx.emit(MoveUndone())


def redo(ctx: Context) -> None:
    """Replay the last undone move (the Y key and the HUD's Redo button)."""
    attempt = ctx.get(Attempt)
    if not attempt.redo or not in_play(ctx):
        return
    letter = attempt.redo.pop()
    attempt.history.append(letter)
    yard = yard_of(ctx.world)
    go_forward(ctx, yard, step(yard, STEPS[letter.lower()]))


def reset(ctx: Context) -> None:
    """Restart the level; its moves come off the shift total (the R key and the HUD)."""
    if not in_play(ctx):
        return
    ctx.get(Shift).total_moves -= ctx.get(Attempt).moves
    ctx.emit(LevelReset())
    ctx.scenes.reload()


MOVES = ((Controls.up, Cell.UP), (Controls.down, Cell.DOWN),
         (Controls.left, Cell.LEFT), (Controls.right, Cell.RIGHT))
COMMANDS = ((Controls.undo, undo), (Controls.redo, redo), (Controls.reset, reset))


@system("yard_rules", scenes=[Scenes.yard], when=in_play)
class YardRules(System):
    """The rules of the yard: steps and pushes from the direction keys, and the undo,
    redo and reset keys. Those three call the same functions as the HUD's buttons. A
    solved level takes no more input while it lingers (`when=`)."""

    def update(self, ctx, dt):
        for action, command in COMMANDS:
            if ctx.input.pressed(action):
                command(ctx)
                return
        direction = next((direction for action, direction in MOVES if ctx.input.pressed(action)), None)
        if direction is not None:
            walk(ctx, direction)


def walk(ctx: Context, direction: Cell) -> None:
    yard = yard_of(ctx.world)
    move = step(yard, direction)
    if move is None:
        ctx.emit(Bumped())
        return
    attempt = ctx.get(Attempt)
    attempt.history.append(move.letter)
    attempt.redo = []
    go_forward(ctx, yard, move)


def go_forward(ctx: Context, before: Yard, move: Move) -> None:
    perform(ctx, move)
    count(ctx, move.letter, +1)
    crate_from, crate_to = move.crate or (None, None)
    was_docked, now_docked = crate_from in before.pads, crate_to in before.pads
    ctx.emit(Stepped(pushed=move.crate is not None,
                     docked=now_docked and not was_docked,
                     undocked=was_docked and not now_docked))
    if yard_of(ctx.world).solved:
        ctx.emit(LevelSolved(level=ctx.get(Shift).level_index + 1))


def perform(ctx: Context, move: Move) -> None:
    """Slide the bot, and the crate it shifts, to their new cells."""
    grid = yard_grid(ctx.world)
    if move.crate is not None:
        start, end = move.crate
        slide(ctx, grid, grid.first_at(start, tagged=Crate), end)
    slide(ctx, grid, ctx.world.query(tagged=Bot).single(), move.bot)


def slide(ctx: Context, grid: Grid, piece: Entity, cell: Cell) -> None:
    piece.get(GridCell).cell = cell
    piece.transform.move_to(grid.center(cell).xy(), ctx.config(Rules).step_seconds, ease="out_quad")


def count(ctx: Context, letter: str, sign: int) -> None:
    attempt = ctx.get(Attempt)
    attempt.moves += sign
    ctx.get(Shift).total_moves += sign
    if letter.isupper():
        attempt.pushes += sign

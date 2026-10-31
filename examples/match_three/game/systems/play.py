from parallax import Context, System, system
from project import Scenes

from game.actions import Controls
from game.board import board_grid, busy, show_hint
from game.cascade import resolve_swap
from game.config import Rules
from game.resources import BoardState


@system("play", scenes=[Scenes.board], when=lambda ctx: not busy(ctx))
class Play(System):
    """The player's side of the board. A tap selects a gem; a tap on a neighbour
    starts the swap, played out as one task (`resolve_swap`) whose handle in
    `BoardState.resolving` is the board's "busy" state. Tapping the selected gem
    again lets it go; tapping any other gem selects that one instead. After
    `hint_delay` idle seconds with nothing selected, it points out a legal swap."""

    def update(self, ctx, dt):
        board = ctx.get(BoardState)
        if ctx.input.pressed(Controls.select):
            tap(ctx, board)
        elif board.selected is None and not board.hint:
            board.idle += dt
            if board.idle >= ctx.config(Rules).hint_delay:
                show_hint(ctx)


def tap(ctx: Context, board: BoardState) -> None:
    cell = board_grid(ctx.world).cell_at(ctx.input.pointer.world)
    if cell is None:
        return
    board.idle = 0.0
    board.hint = []
    if board.selected is not None and board.selected.manhattan(cell) == 1:
        a, b = board.selected, cell
        board.selected = None
        board.resolving = ctx.run(lambda ctx, task: resolve_swap(ctx, task, a, b))
    elif board.selected == cell:
        board.selected = None
    else:
        board.selected = cell

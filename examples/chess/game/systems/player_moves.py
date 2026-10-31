from dataclasses import replace

from parallax import System, system
from project import Scenes

from game.config import Sounds
from game.board import HUMAN, board, human_to_move, position
from game.chess.moves import moves_from
from game.chess.position import color_of, square_at
from game.events import MoveChosen, SelectionChanged
from game.resources import Selection


@system("player_moves", scenes=[Scenes.board], when=human_to_move)
class PlayerMoves(System):
    """Turns taps on the board into the player's moves: tap a piece to pick it
    up, tap a highlighted square to move it there. A pawn move to the last rank
    waits in `Selection.promotion`, which opens the promotion picker."""

    def update(self, ctx, dt):
        pointer = ctx.input.pointer
        if pointer.pressed:
            cell = board(ctx).cell_at(pointer.world)
            self.tap(ctx, square_at(cell) if cell is not None else None)

    def tap(self, ctx, square: int | None):
        selection = ctx.get(Selection)
        now = position(ctx)
        picked = moves_from(now, selection.square) if selection.square is not None else []
        landing = next((move for move in picked if move.target == square), None)
        piece = now.board[square] if square is not None else ""

        if landing and landing.promotion:
            selection.promotion = replace(landing, promotion="").uci()
        elif landing:
            ctx.emit(MoveChosen(move=landing.uci()))

        if not landing and piece and color_of(piece) == HUMAN:
            selection.square = square
            ctx.audio.play(ctx.config(Sounds).select, volume=0.28)
        else:
            selection.square = None
        ctx.emit(SelectionChanged())

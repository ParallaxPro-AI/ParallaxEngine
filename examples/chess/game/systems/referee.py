from parallax import System, on, system
from project import Scenes

from game.board import COMPUTER, in_play
from game.chess.moves import captured_square, find_move, play
from game.chess.notation import san
from game.chess.position import Position
from game.chess.status import Ending, ending_of
from game.config import Rules, Setup
from game.events import MatchEnded, MatchStarted, MoveChosen, MoveMade, Resigned
from game.resources import Match


@system("referee", scenes=[Scenes.board])
class Referee(System):
    """Owns the match: sets out the opening position, plays every legal move
    chosen by either side, and calls the result. An ending is recorded before
    `MoveMade` goes out, so nobody answers a mating move."""

    def start(self, ctx):
        match = ctx.get(Match)
        match.fen = ctx.config(Setup).fen
        match.history = [Position.from_fen(match.fen).key()]
        ctx.emit(MatchStarted())

    @on(MoveChosen, when=in_play)
    def play_move(self, ctx, event: MoveChosen):
        match = ctx.get(Match)
        before = Position.from_fen(match.fen)
        move = find_move(before, event.move)
        if move is None:
            return
        after = play(before, move)
        victim = before.board[captured_square(move)]

        match.fen = after.fen()
        match.history.append(after.key())
        match.moves.append(san(before, move, after))
        if victim:
            match.captured.append(victim)

        rules = ctx.config(Rules)
        ending = ending_of(
            after,
            match.history,
            fifty_move_plies=rules.fifty_move_plies,
            repetitions=rules.repetitions,
            dead_positions=rules.dead_positions_draw,
        )
        if ending is not None:
            self.finish(ctx, ending, winner=before.turn if ending is Ending.CHECKMATE else "")
        ctx.emit(MoveMade(move=event.move, before=before.fen()))

    @on(Resigned, when=in_play)
    def resign(self, ctx, event):
        self.finish(ctx, Ending.RESIGNATION, winner=COMPUTER)

    def finish(self, ctx, ending: Ending, winner: str):
        match = ctx.get(Match)
        match.ending = ending
        match.winner = winner
        ctx.emit(MatchEnded(ending=ending, winner=winner))

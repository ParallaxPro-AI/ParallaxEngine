from parallax import System, on, system
from project import Scenes

from game.board import HUMAN, in_play
from game.events import DiscChosen, DiscDropped, MatchEnded
from game.resources import Match, Result
from game.well import drop, is_full, open_columns, turn, winning_run


@system("referee", scenes=[Scenes.well])
class Referee(System):
    """Owns the well: drops every legal disc while the game is in play, and calls
    a line of four or a full well. The result is settled before `DiscDropped`
    goes out, so the opponent never answers a finishing drop."""

    @on(DiscChosen, when=in_play)
    def drop_disc(self, ctx, event: DiscChosen):
        match = ctx.get(Match)
        if event.disc is not turn(match.cells) or event.column not in open_columns(match.cells):
            return
        match.cells, at = drop(match.cells, event.column, event.disc)
        match.winning_line = winning_run(match.cells, at)
        if match.winning_line:
            match.result = Result.WIN if event.disc is HUMAN else Result.LOSS
        elif is_full(match.cells):
            match.result = Result.DRAW

        ctx.emit(DiscDropped(cell=at, disc=event.disc))
        if match.result is not None:
            ctx.emit(MatchEnded(result=match.result))

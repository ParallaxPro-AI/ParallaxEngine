from parallax import System, system
from project import Scenes, Text

from game.cues import Cues, play
from game.feed import Kind, say
from game.resources import Board


def clock_running(ctx) -> bool:
    board = ctx.get(Board)
    return board.loaded and not board.late


@system("contract_clock", scenes=[Scenes.archipelago], when=clock_running)
class ContractClock(System):
    """Runs the clock on the load aboard. When it reaches zero the job is late and pays
    the late rate on delivery."""

    def update(self, ctx, dt):
        board = ctx.get(Board)
        board.time_left = max(0.0, board.time_left - dt)
        if board.time_left == 0:
            board.late = True
            play(ctx, ctx.config(Cues).late)
            say(ctx, ctx.text(Text.clock_ran_out), Kind.BAD)

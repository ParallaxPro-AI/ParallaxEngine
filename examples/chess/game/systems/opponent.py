import random

from parallax import System, on, system
from project import Scenes

from game.board import COMPUTER, in_play, position
from game.chess.evaluate import Weights
from game.chess.moves import legal_moves
from game.chess.position import Move, Position
from game.chess.search import Style, best_move
from game.config import Evaluation, Rules
from game.content import DifficultyDef
from game.events import MoveChosen, MoveMade
from game.resources import Session


@system("opponent", scenes=[Scenes.board])
class Opponent(System):
    """Plays the computer's side: after each of the player's moves it takes a
    thinking beat, then searches for a reply at the chosen difficulty."""

    @on(MoveMade, when=in_play)
    def reply(self, ctx, event: MoveMade):
        if position(ctx).turn == COMPUTER:
            ctx.run(computer_move)


async def computer_move(ctx, task):
    """A thinking beat (frozen by modal panels), then the computer's move. If the
    player resigns meanwhile, the referee ignores the reply."""
    rules = ctx.config(Rules)
    await task.seconds(rules.think_seconds)
    move = choose_move(position(ctx), ctx.get(Session).difficulty.data, ctx.config(Evaluation), rules.node_budget)
    ctx.emit(MoveChosen(move=move.uci()))


def choose_move(position: Position, difficulty: DifficultyDef, evaluation: Evaluation, node_budget: int) -> Move:
    """The searched best move — or, `blunder` of the time, any legal move, which
    is what makes the easy opponent beatable."""
    moves = legal_moves(position)
    if random.random() < difficulty.blunder:
        return random.choice(moves)
    style = Style(
        depth=difficulty.depth,
        weights=Weights(evaluation.piece_values, evaluation.piece_squares, difficulty.positional),
        aggression=difficulty.aggression,
    )
    return best_move(position, moves, style, node_budget)

from parallax import Game
from parallax.plugins import grid
from project import Scenes

from game.logic import BoardView, Opponent, PlayerMarks, Referee, Results

game = Game(
    id="tic_tac_toe",
    title="Trine — Claim the Line",
    sdk="1.0",
    mode="2d",
    plugins=[grid()],
    systems=[PlayerMarks, Referee, Opponent, BoardView, Results],
    start_scene=Scenes.title,
)

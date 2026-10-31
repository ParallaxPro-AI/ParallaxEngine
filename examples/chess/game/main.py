from parallax import Game
from parallax.plugins import grid
from project import Scenes

from game.systems.board_view import BoardView
from game.systems.highlights import Highlights
from game.systems.opponent import Opponent
from game.systems.player_moves import PlayerMoves
from game.systems.referee import Referee
from game.systems.results import Results

game = Game(
    id="chess",
    title="Chess",
    sdk="1.0",
    mode="2d",
    plugins=[grid()],
    systems=[PlayerMoves, Referee, Opponent, BoardView, Highlights, Results],
    start_scene=Scenes.title,
)

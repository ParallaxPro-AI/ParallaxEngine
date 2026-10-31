from parallax import Game
from parallax.plugins import grid
from project import Scenes

from game.systems.opponent import Opponent
from game.systems.player_drops import PlayerDrops
from game.systems.referee import Referee
from game.systems.results import Results
from game.systems.well_view import WellView

game = Game(
    id="four_in_a_row",
    title="Dropline — Four in the Well",
    sdk="1.0",
    mode="2d",
    plugins=[grid()],
    systems=[PlayerDrops, Referee, Opponent, WellView, Results],
    start_scene=Scenes.title,
)

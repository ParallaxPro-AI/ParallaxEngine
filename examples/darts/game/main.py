from parallax import Game
from parallax.plugins import physics3d, terrain
from project import Scenes

from game.systems.draught import Draught
from game.systems.feedback import Feedback
from game.systems.scorekeeper import Scorekeeper
from game.systems.tour import Tour

game = Game(
    id="darts",
    title="Tungsten Alley",
    sdk="1.0",
    mode="3d",
    plugins=[physics3d(gravity=-9.81), terrain()],
    systems=[Scorekeeper, Draught, Tour, Feedback],
    start_scene=Scenes.title,
)

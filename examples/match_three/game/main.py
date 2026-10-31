from parallax import Game
from parallax.plugins import grid
from project import Scenes

from game.systems.dealer import Dealer
from game.systems.feedback import Feedback
from game.systems.play import Play
from game.systems.scoring import Scoring
from game.systems.stages import Stages

game = Game(
    id="match_three",
    title="Gem Cascade",
    sdk="1.0",
    mode="2d",
    start_scene=Scenes.title,
    plugins=[grid()],
    systems=[Dealer, Play, Scoring, Stages, Feedback],
)

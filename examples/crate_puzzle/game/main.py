from parallax import Game
from parallax.plugins import grid
from project import Scenes

from game.systems.builder import Builder
from game.systems.feedback import Feedback
from game.systems.progress import Progress
from game.systems.yard import YardRules

game = Game(
    id="crate_puzzle",
    title="Dockbot",
    sdk="1.0",
    mode="2d",
    start_scene=Scenes.title,
    plugins=[grid()],
    systems=[Builder, YardRules, Progress, Feedback],
)

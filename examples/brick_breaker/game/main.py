from parallax import Game
from parallax.plugins import combat, grid, physics3d
from project import Scenes

from game.systems.feedback import Feedback
from game.systems.outcome import Outcome
from game.systems.scoring import Scoring
from game.systems.stages import Stages
from game.systems.upgrades import Upgrades

game = Game(
    id="brick_breaker",
    title="Prism Smash",
    sdk="1.0",
    mode="3d",
    plugins=[physics3d(gravity=0), combat(), grid()],
    systems=[Upgrades, Stages, Scoring, Outcome, Feedback],
    start_scene=Scenes.title,
)

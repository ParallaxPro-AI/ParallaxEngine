from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

from game.systems.duels import Duels
from game.systems.feedback import Feedback
from game.systems.outcome import Outcome
from game.systems.perks import Perks
from game.systems.scoring import Scoring

game = Game(
    id="paddle_duel",
    title="Volley Circuit",
    sdk="1.0",
    mode="3d",
    plugins=[physics3d(gravity=0)],
    systems=[Perks, Duels, Scoring, Outcome, Feedback],
    start_scene=Scenes.title,
)

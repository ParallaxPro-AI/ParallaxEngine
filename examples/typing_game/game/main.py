from parallax import Game
from project import Scenes

from game.systems.feedback import Feedback
from game.systems.firewall import Firewall
from game.systems.judge import Judge

game = Game(
    id="typing_game",
    title="Keystrike",
    sdk="1.0",
    mode="3d",
    start_scene=Scenes.title,
    systems=[Judge, Firewall, Feedback],
)

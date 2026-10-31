from parallax import Game
from project import Scenes

from game.systems import Counter, Steering

game = Game(
    id="tally",
    title="Tally",
    sdk="1.0",
    mode="2d",
    start_scene=Scenes.title,
    systems=[Counter, Steering],
)

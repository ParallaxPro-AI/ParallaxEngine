from parallax import Game
from parallax.plugins import grid
from project import Scenes

from game.systems.dealer import Dealer, Wells
from game.systems.feedback import Feedback
from game.systems.slider import Slider

game = Game(
    id="number_merge",
    title="Twofold",
    sdk="1.0",
    mode="2d",
    start_scene=Scenes.title,
    plugins=[grid()],
    systems=[Wells, Dealer, Slider, Feedback],
)

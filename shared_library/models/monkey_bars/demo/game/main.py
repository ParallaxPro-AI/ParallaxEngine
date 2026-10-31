"""Demo host for the monkey_bars model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="monkey_bars_demo", title="monkey_bars demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

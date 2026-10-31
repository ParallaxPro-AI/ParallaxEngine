"""Demo host for the railway_signal model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="railway_signal_demo", title="railway_signal demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the training_dummy model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="training_dummy_demo", title="training_dummy demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the train_set_wooden model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="train_set_wooden_demo", title="train_set_wooden demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

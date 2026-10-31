"""Demo host for the scientist_lab model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="scientist_lab_demo", title="scientist_lab demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

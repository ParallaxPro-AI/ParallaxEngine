"""Demo host for the aquarium_large model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="aquarium_large_demo", title="aquarium_large demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

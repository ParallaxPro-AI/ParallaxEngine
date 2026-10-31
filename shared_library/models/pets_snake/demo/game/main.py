"""Demo host for the pets_snake model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="pets_snake_demo", title="pets_snake demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

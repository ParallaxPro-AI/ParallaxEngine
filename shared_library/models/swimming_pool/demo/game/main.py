"""Demo host for the swimming_pool model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="swimming_pool_demo", title="swimming_pool demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

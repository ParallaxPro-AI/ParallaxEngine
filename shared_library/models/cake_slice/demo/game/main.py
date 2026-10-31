"""Demo host for the cake_slice model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cake_slice_demo", title="cake_slice demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

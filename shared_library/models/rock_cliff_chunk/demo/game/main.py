"""Demo host for the rock_cliff_chunk model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="rock_cliff_chunk_demo", title="rock_cliff_chunk demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

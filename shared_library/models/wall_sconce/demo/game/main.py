"""Demo host for the wall_sconce model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="wall_sconce_demo", title="wall_sconce demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

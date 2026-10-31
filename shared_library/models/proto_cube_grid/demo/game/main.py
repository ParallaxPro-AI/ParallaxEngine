"""Demo host for the proto_cube_grid model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="proto_cube_grid_demo", title="proto_cube_grid demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

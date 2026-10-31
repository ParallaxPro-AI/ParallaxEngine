"""Demo host for the mosaic_floor_tile model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mosaic_floor_tile_demo", title="mosaic_floor_tile demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

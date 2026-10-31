"""Demo host for the air_compressor model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="air_compressor_demo", title="air_compressor demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

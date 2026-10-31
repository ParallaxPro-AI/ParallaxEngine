"""Demo host for the life_buoy model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="life_buoy_demo", title="life_buoy demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

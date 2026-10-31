"""Demo host for the barrier_water_filled model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="barrier_water_filled_demo", title="barrier_water_filled demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

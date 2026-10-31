"""Demo host for the water_cooler model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="water_cooler_demo", title="water_cooler demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

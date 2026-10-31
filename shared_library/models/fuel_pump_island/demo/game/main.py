"""Demo host for the fuel_pump_island model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fuel_pump_island_demo", title="fuel_pump_island demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

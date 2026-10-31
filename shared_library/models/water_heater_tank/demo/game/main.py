"""Demo host for the water_heater_tank model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="water_heater_tank_demo", title="water_heater_tank demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

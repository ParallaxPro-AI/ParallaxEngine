"""Demo host for the concrete_pump_truck_boom model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d, vehicles
from project import Scenes

game = Game(id="concrete_pump_truck_boom_demo", title="concrete_pump_truck_boom demo", sdk="1.0", mode="3d",
            plugins=[physics3d(), vehicles()], start_scene=Scenes.yard)

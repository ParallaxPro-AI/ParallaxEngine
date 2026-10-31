"""Demo host for the car_carrier model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d, vehicles
from project import Scenes

game = Game(id="car_carrier_demo", title="car_carrier demo", sdk="1.0", mode="3d",
            plugins=[physics3d(), vehicles()], start_scene=Scenes.yard)

"""Demo host for the stock_car_racer model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d, vehicles
from project import Scenes

game = Game(id="stock_car_racer_demo", title="stock_car_racer demo", sdk="1.0", mode="3d",
            plugins=[physics3d(), vehicles()], start_scene=Scenes.yard)

"""Demo host for the car_showroom model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="car_showroom_demo", title="car_showroom demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

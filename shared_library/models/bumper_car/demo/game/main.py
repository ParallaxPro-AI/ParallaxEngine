"""Demo host for the bumper_car model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="bumper_car_demo", title="bumper_car demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

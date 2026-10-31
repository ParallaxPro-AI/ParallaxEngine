"""Demo host for the car_wreck_burnt model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="car_wreck_burnt_demo", title="car_wreck_burnt demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

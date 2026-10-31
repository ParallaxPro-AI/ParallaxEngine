"""Demo host for the satellite_dish model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="satellite_dish_demo", title="satellite_dish demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

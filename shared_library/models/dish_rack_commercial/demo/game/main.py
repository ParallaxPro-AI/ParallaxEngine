"""Demo host for the dish_rack_commercial model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="dish_rack_commercial_demo", title="dish_rack_commercial demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

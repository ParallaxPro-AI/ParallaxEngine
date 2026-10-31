"""Demo host for the metro_car_nyc model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="metro_car_nyc_demo", title="metro_car_nyc demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

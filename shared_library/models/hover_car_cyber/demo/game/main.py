"""Demo host for the hover_car_cyber model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="hover_car_cyber_demo", title="hover_car_cyber demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

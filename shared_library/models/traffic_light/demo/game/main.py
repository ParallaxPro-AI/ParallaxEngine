"""Demo host for the traffic_light model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="traffic_light_demo", title="traffic_light demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

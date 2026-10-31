"""Demo host for the bus_stop model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="bus_stop_demo", title="bus_stop demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

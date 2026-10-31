"""Demo host for the bus_wreck model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="bus_wreck_demo", title="bus_wreck demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

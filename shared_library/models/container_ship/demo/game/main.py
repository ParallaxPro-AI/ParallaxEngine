"""Demo host for the container_ship model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="container_ship_demo", title="container_ship demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

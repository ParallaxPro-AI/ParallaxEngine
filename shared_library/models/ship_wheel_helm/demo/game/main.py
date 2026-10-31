"""Demo host for the ship_wheel_helm model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="ship_wheel_helm_demo", title="ship_wheel_helm demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

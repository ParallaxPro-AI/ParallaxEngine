"""Demo host for the wagon_wheel model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="wagon_wheel_demo", title="wagon_wheel demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

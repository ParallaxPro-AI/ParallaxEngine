"""Demo host for the double_door model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="double_door_demo", title="double_door demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the door_boards model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="door_boards_demo", title="door_boards demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

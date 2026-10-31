"""Demo host for the room_divider model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="room_divider_demo", title="room_divider demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the waiting_room_chairs model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="waiting_room_chairs_demo", title="waiting_room_chairs demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

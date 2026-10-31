"""Demo host for the fitting_room model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fitting_room_demo", title="fitting_room demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

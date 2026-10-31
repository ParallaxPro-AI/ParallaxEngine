"""Demo host for the picture_frame model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="picture_frame_demo", title="picture_frame demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

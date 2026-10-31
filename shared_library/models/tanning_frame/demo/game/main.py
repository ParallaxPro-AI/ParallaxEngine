"""Demo host for the tanning_frame model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tanning_frame_demo", title="tanning_frame demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

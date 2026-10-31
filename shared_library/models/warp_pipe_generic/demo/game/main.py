"""Demo host for the warp_pipe_generic model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="warp_pipe_generic_demo", title="warp_pipe_generic demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

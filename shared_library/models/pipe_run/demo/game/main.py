"""Demo host for the pipe_run model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="pipe_run_demo", title="pipe_run demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

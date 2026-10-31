"""Demo host for the worktop_run model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="worktop_run_demo", title="worktop_run demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

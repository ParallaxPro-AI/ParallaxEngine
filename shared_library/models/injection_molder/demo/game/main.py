"""Demo host for the injection_molder model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="injection_molder_demo", title="injection_molder demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the power_core model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="power_core_demo", title="power_core demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

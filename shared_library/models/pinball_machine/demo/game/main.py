"""Demo host for the pinball_machine model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="pinball_machine_demo", title="pinball_machine demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

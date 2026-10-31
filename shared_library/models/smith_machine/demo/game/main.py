"""Demo host for the smith_machine model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="smith_machine_demo", title="smith_machine demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

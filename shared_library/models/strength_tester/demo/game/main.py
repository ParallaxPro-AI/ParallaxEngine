"""Demo host for the strength_tester model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="strength_tester_demo", title="strength_tester demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

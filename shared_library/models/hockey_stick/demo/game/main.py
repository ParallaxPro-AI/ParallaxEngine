"""Demo host for the hockey_stick model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="hockey_stick_demo", title="hockey_stick demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

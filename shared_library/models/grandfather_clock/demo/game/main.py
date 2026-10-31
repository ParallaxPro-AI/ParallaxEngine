"""Demo host for the grandfather_clock model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="grandfather_clock_demo", title="grandfather_clock demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

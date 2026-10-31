"""Demo host for the elderly_woman model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="elderly_woman_demo", title="elderly_woman demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

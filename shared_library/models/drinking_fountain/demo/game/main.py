"""Demo host for the drinking_fountain model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="drinking_fountain_demo", title="drinking_fountain demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

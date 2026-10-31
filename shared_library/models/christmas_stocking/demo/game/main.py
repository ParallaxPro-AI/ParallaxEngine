"""Demo host for the christmas_stocking model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="christmas_stocking_demo", title="christmas_stocking demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

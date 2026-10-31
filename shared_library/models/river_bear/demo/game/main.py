"""Demo host for the river_bear model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="river_bear_demo", title="river_bear demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

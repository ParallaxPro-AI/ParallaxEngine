"""Demo host for the river_cobble model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="river_cobble_demo", title="river_cobble demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

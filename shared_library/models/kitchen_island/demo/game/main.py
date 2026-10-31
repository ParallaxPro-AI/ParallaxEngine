"""Demo host for the kitchen_island model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="kitchen_island_demo", title="kitchen_island demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

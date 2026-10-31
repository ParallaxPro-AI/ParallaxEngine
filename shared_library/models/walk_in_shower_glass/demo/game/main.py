"""Demo host for the walk_in_shower_glass model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="walk_in_shower_glass_demo", title="walk_in_shower_glass demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

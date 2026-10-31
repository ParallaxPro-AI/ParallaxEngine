"""Demo host for the house_stairs_spiral model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="house_stairs_spiral_demo", title="house_stairs_spiral demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

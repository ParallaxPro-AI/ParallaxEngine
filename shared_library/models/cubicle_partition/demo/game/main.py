"""Demo host for the cubicle_partition model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cubicle_partition_demo", title="cubicle_partition demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

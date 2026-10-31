"""Demo host for the cement_bag_pallet model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cement_bag_pallet_demo", title="cement_bag_pallet demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

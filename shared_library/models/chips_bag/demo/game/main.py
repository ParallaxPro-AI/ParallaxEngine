"""Demo host for the chips_bag model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="chips_bag_demo", title="chips_bag demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

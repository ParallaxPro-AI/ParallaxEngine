"""Demo host for the loot_bag model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="loot_bag_demo", title="loot_bag demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

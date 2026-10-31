"""Demo host for the mage_tower model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mage_tower_demo", title="mage_tower demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

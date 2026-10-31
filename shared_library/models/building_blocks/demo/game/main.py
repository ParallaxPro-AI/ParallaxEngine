"""Demo host for the building_blocks model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="building_blocks_demo", title="building_blocks demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

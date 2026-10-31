"""Demo host for the supply_cache model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="supply_cache_demo", title="supply_cache demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

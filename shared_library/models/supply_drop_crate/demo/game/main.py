"""Demo host for the supply_drop_crate model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="supply_drop_crate_demo", title="supply_drop_crate demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

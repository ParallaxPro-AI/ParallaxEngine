"""Demo host for the scifi_supply_crate model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="scifi_supply_crate_demo", title="scifi_supply_crate demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

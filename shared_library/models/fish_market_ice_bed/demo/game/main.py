"""Demo host for the fish_market_ice_bed model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fish_market_ice_bed_demo", title="fish_market_ice_bed demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

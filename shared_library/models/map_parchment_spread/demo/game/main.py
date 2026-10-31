"""Demo host for the map_parchment_spread model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="map_parchment_spread_demo", title="map_parchment_spread demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

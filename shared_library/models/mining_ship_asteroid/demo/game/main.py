"""Demo host for the mining_ship_asteroid model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mining_ship_asteroid_demo", title="mining_ship_asteroid demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the market_stall_tech model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="market_stall_tech_demo", title="market_stall_tech demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

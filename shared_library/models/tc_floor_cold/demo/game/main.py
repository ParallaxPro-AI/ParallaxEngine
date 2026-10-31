"""Demo host for the tc_floor_cold model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tc_floor_cold_demo", title="tc_floor_cold demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

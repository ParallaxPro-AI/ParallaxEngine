"""Demo host for the tc_floor_rug model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tc_floor_rug_demo", title="tc_floor_rug demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

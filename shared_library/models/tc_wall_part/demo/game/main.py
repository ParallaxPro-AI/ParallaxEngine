"""Demo host for the tc_wall_part model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tc_wall_part_demo", title="tc_wall_part demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

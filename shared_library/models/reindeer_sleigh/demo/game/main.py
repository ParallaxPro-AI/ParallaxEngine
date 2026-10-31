"""Demo host for the reindeer_sleigh model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="reindeer_sleigh_demo", title="reindeer_sleigh demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

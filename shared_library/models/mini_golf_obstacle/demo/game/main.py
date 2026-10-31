"""Demo host for the mini_golf_obstacle model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="mini_golf_obstacle_demo", title="mini_golf_obstacle demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

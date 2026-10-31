"""Demo host for the goal_flag_pole model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="goal_flag_pole_demo", title="goal_flag_pole demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the football_goal_full model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="football_goal_full_demo", title="football_goal_full demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

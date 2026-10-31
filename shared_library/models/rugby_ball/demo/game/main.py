"""Demo host for the rugby_ball model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="rugby_ball_demo", title="rugby_ball demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

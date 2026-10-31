"""Demo host for the soccer_ball model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="soccer_ball_demo", title="soccer_ball demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

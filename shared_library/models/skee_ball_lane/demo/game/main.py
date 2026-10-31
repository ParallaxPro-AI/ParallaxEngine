"""Demo host for the skee_ball_lane model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="skee_ball_lane_demo", title="skee_ball_lane demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

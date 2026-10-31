"""Demo host for the lunar_lander model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="lunar_lander_demo", title="lunar_lander demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

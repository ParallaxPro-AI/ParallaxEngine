"""Demo host for the stair_climber model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="stair_climber_demo", title="stair_climber demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

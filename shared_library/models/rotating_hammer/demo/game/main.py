"""Demo host for the rotating_hammer model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="rotating_hammer_demo", title="rotating_hammer demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

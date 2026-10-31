"""Demo host for the tire_stack model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tire_stack_demo", title="tire_stack demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

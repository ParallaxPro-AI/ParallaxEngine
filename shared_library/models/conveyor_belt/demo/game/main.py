"""Demo host for the conveyor_belt model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="conveyor_belt_demo", title="conveyor_belt demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

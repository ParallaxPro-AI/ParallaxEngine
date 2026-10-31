"""Demo host for the steak_plate model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="steak_plate_demo", title="steak_plate demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

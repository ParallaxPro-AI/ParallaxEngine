"""Demo host for the wet_floor_sign model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="wet_floor_sign_demo", title="wet_floor_sign demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

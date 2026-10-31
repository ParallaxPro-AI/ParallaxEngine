"""Demo host for the nurse model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="nurse_demo", title="nurse demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the medical_cart_crash model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="medical_cart_crash_demo", title="medical_cart_crash demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

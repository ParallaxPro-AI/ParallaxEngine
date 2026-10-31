"""Demo host for the souk_apartment_pink model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="souk_apartment_pink_demo", title="souk_apartment_pink demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

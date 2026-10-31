"""Demo host for the apartment_lowrise model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="apartment_lowrise_demo", title="apartment_lowrise demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

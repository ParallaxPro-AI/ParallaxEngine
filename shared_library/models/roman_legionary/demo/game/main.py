"""Demo host for the roman_legionary model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="roman_legionary_demo", title="roman_legionary demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

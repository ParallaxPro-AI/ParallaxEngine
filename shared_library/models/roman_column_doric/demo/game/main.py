"""Demo host for the roman_column_doric model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="roman_column_doric_demo", title="roman_column_doric demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

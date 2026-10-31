"""Demo host for the ore_rock_copper model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="ore_rock_copper_demo", title="ore_rock_copper demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

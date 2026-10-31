"""Demo host for the beach_umbrella model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="beach_umbrella_demo", title="beach_umbrella demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

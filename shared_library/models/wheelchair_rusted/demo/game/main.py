"""Demo host for the wheelchair_rusted model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="wheelchair_rusted_demo", title="wheelchair_rusted demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

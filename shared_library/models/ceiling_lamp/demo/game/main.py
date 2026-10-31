"""Demo host for the ceiling_lamp model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="ceiling_lamp_demo", title="ceiling_lamp demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

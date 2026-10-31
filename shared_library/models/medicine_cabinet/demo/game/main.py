"""Demo host for the medicine_cabinet model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="medicine_cabinet_demo", title="medicine_cabinet demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

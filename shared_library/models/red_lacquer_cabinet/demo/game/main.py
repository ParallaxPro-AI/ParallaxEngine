"""Demo host for the red_lacquer_cabinet model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="red_lacquer_cabinet_demo", title="red_lacquer_cabinet demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

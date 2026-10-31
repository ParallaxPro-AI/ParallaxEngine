"""Demo host for the bush_round model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="bush_round_demo", title="bush_round demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

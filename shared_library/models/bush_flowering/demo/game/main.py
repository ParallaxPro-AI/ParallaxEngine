"""Demo host for the bush_flowering model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="bush_flowering_demo", title="bush_flowering demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

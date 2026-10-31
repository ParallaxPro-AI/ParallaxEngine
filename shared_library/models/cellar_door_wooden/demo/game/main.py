"""Demo host for the cellar_door_wooden model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cellar_door_wooden_demo", title="cellar_door_wooden demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

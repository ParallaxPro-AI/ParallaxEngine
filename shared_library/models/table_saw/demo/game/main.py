"""Demo host for the table_saw model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="table_saw_demo", title="table_saw demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

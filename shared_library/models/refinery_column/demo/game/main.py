"""Demo host for the refinery_column model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="refinery_column_demo", title="refinery_column demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

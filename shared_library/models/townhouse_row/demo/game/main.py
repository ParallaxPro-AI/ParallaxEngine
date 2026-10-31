"""Demo host for the townhouse_row model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="townhouse_row_demo", title="townhouse_row demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

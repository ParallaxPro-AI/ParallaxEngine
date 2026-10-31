"""Demo host for the prison_cell model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="prison_cell_demo", title="prison_cell demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

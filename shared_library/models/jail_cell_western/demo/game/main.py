"""Demo host for the jail_cell_western model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="jail_cell_western_demo", title="jail_cell_western demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

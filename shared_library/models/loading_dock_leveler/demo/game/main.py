"""Demo host for the loading_dock_leveler model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="loading_dock_leveler_demo", title="loading_dock_leveler demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

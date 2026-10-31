"""Demo host for the tower_plinth model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tower_plinth_demo", title="tower_plinth demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

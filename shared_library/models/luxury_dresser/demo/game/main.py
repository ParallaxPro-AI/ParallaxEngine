"""Demo host for the luxury_dresser model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="luxury_dresser_demo", title="luxury_dresser demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the flashbang model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d, viewmodel
from project import Scenes

game = Game(id="flashbang_demo", title="flashbang demo", sdk="1.0", mode="3d",
            plugins=[physics3d(), viewmodel()], start_scene=Scenes.yard)

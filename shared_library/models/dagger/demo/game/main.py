"""Demo host for the dagger model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d, viewmodel
from project import Scenes

game = Game(id="dagger_demo", title="dagger demo", sdk="1.0", mode="3d",
            plugins=[physics3d(), viewmodel()], start_scene=Scenes.yard)

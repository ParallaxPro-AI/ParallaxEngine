"""Demo host for the witch_broom model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d, viewmodel
from project import Scenes

game = Game(id="witch_broom_demo", title="witch_broom demo", sdk="1.0", mode="3d",
            plugins=[physics3d(), viewmodel()], start_scene=Scenes.yard)

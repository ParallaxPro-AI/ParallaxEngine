"""Demo host for the lmg model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d, viewmodel
from project import Scenes

game = Game(id="lmg_demo", title="lmg demo", sdk="1.0", mode="3d",
            plugins=[physics3d(), viewmodel()], start_scene=Scenes.yard)

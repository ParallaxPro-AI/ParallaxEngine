"""Demo host for the grey_alien model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="grey_alien_demo", title="grey_alien demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

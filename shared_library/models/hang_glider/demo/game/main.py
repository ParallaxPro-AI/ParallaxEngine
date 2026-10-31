"""Demo host for the hang_glider model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="hang_glider_demo", title="hang_glider demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

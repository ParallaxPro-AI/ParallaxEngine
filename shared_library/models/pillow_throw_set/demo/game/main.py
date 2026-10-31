"""Demo host for the pillow_throw_set model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="pillow_throw_set_demo", title="pillow_throw_set demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

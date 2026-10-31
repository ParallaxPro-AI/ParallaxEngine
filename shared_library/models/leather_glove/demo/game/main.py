"""Demo host for the leather_glove model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="leather_glove_demo", title="leather_glove demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

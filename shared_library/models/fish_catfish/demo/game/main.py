"""Demo host for the fish_catfish model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fish_catfish_demo", title="fish_catfish demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

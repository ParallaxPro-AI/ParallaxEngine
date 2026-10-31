"""Demo host for the fish_goldfish model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fish_goldfish_demo", title="fish_goldfish demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

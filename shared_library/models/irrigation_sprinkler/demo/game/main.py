"""Demo host for the irrigation_sprinkler model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="irrigation_sprinkler_demo", title="irrigation_sprinkler demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

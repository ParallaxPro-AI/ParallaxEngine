"""Demo host for the cooking_spit model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cooking_spit_demo", title="cooking_spit demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

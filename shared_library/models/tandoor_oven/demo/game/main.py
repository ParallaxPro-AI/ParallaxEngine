"""Demo host for the tandoor_oven model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tandoor_oven_demo", title="tandoor_oven demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

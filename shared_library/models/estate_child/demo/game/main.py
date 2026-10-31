"""Demo host for the estate_child model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="estate_child_demo", title="estate_child demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

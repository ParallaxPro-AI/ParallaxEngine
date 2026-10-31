"""Demo host for the child_girl model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="child_girl_demo", title="child_girl demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

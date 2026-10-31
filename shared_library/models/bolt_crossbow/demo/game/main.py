"""Demo host for the bolt_crossbow model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="bolt_crossbow_demo", title="bolt_crossbow demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the modern_armchair model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="modern_armchair_demo", title="modern_armchair demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

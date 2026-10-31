"""Demo host for the houseplant_fiddle_leaf model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="houseplant_fiddle_leaf_demo", title="houseplant_fiddle_leaf demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

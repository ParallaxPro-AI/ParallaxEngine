"""Demo host for the tree_autumn_maple model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tree_autumn_maple_demo", title="tree_autumn_maple demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

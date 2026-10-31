"""Demo host for the tree_oak model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tree_oak_demo", title="tree_oak demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

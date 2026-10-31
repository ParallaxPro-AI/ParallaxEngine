"""Demo host for the tree_cherry_blossom model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="tree_cherry_blossom_demo", title="tree_cherry_blossom demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

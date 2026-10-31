"""Demo host for the cat_tree model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cat_tree_demo", title="cat_tree demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

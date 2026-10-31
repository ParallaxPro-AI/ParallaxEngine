"""Demo host for the fuse_puzzle_box model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="fuse_puzzle_box_demo", title="fuse_puzzle_box demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

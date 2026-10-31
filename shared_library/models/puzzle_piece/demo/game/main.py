"""Demo host for the puzzle_piece model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="puzzle_piece_demo", title="puzzle_piece demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

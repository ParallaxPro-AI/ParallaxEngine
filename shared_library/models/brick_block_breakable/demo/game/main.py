"""Demo host for the brick_block_breakable model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="brick_block_breakable_demo", title="brick_block_breakable demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

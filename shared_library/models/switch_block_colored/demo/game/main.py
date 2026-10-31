"""Demo host for the switch_block_colored model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="switch_block_colored_demo", title="switch_block_colored demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

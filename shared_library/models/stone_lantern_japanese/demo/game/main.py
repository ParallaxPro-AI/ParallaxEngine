"""Demo host for the stone_lantern_japanese model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="stone_lantern_japanese_demo", title="stone_lantern_japanese demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

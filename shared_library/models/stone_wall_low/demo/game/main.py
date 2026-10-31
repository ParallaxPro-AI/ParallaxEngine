"""Demo host for the stone_wall_low model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="stone_wall_low_demo", title="stone_wall_low demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the cave_entrance model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="cave_entrance_demo", title="cave_entrance demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

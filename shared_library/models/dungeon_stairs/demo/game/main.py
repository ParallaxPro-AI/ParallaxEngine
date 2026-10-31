"""Demo host for the dungeon_stairs model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="dungeon_stairs_demo", title="dungeon_stairs demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

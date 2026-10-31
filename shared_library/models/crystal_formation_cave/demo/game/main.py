"""Demo host for the crystal_formation_cave model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="crystal_formation_cave_demo", title="crystal_formation_cave demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

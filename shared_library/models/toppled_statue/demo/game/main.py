"""Demo host for the toppled_statue model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="toppled_statue_demo", title="toppled_statue demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

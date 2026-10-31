"""Demo host for the skeleton_warrior model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="skeleton_warrior_demo", title="skeleton_warrior demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

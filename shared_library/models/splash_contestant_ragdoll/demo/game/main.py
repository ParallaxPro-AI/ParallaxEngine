"""Demo host for the splash_contestant_ragdoll model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="splash_contestant_ragdoll_demo", title="splash_contestant_ragdoll demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

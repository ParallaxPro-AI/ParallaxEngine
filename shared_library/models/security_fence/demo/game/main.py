"""Demo host for the security_fence model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="security_fence_demo", title="security_fence demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

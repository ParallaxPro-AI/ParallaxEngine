"""Demo host for the wooden_bridge model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="wooden_bridge_demo", title="wooden_bridge demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

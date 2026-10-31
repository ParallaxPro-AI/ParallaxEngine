"""Demo host for the dock_crane_wooden model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="dock_crane_wooden_demo", title="dock_crane_wooden demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

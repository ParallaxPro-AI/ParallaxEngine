"""Demo host for the dock_fishing_village model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="dock_fishing_village_demo", title="dock_fishing_village demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the buoy_navigation model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="buoy_navigation_demo", title="buoy_navigation demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the moon_base_dome model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="moon_base_dome_demo", title="moon_base_dome demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

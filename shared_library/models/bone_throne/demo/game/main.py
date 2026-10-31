"""Demo host for the bone_throne model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="bone_throne_demo", title="bone_throne demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

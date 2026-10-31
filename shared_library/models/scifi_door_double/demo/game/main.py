"""Demo host for the scifi_door_double model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="scifi_door_double_demo", title="scifi_door_double demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

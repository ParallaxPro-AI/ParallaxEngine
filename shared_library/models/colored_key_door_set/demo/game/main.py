"""Demo host for the colored_key_door_set model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="colored_key_door_set_demo", title="colored_key_door_set demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

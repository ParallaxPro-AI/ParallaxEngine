"""Demo host for the kids_play_kitchen model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="kids_play_kitchen_demo", title="kids_play_kitchen demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

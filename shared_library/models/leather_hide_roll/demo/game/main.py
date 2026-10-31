"""Demo host for the leather_hide_roll model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="leather_hide_roll_demo", title="leather_hide_roll demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

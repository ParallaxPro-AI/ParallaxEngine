"""Demo host for the camp_stove model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="camp_stove_demo", title="camp_stove demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

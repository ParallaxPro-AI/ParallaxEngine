"""Demo host for the produce_stand model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="produce_stand_demo", title="produce_stand demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

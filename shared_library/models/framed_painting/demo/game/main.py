"""Demo host for the framed_painting model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="framed_painting_demo", title="framed_painting demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

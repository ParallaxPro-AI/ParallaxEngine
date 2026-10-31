"""Demo host for the shark_great_white model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="shark_great_white_demo", title="shark_great_white demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

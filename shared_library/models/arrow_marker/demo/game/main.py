"""Demo host for the arrow_marker model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="arrow_marker_demo", title="arrow_marker demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

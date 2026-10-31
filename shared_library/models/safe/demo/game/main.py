"""Demo host for the safe model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="safe_demo", title="safe demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

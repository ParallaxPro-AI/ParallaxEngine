"""Demo host for the escape_pod model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="escape_pod_demo", title="escape_pod demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

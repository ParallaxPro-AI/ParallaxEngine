"""Demo host for the broken_mirror model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="broken_mirror_demo", title="broken_mirror demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

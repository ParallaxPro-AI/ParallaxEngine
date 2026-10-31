"""Demo host for the ring_magic model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="ring_magic_demo", title="ring_magic demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

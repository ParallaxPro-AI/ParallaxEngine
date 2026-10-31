"""Demo host for the ring_toss_stall model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="ring_toss_stall_demo", title="ring_toss_stall demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

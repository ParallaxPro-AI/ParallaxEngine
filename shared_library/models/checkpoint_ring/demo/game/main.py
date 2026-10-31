"""Demo host for the checkpoint_ring model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="checkpoint_ring_demo", title="checkpoint_ring demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

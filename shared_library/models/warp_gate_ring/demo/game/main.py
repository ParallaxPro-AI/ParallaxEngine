"""Demo host for the warp_gate_ring model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="warp_gate_ring_demo", title="warp_gate_ring demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the rope_rig model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="rope_rig_demo", title="rope_rig demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

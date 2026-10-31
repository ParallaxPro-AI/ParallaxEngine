"""Demo host for the coconut_half model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="coconut_half_demo", title="coconut_half demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the bmx_ramp model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="bmx_ramp_demo", title="bmx_ramp demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

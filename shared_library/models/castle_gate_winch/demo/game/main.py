"""Demo host for the castle_gate_winch model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="castle_gate_winch_demo", title="castle_gate_winch demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

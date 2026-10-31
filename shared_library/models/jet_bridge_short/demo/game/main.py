"""Demo host for the jet_bridge_short model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="jet_bridge_short_demo", title="jet_bridge_short demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)

"""Demo host for the vase_ceramic model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="vase_ceramic_demo", title="vase_ceramic demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
